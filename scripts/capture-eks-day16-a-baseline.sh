#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---capture}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
CONTRACT="$ROOT_DIR/infra/eks/secrets/runtime-secret-contract.example.json"

fail() {
  echo "$1" >&2
  exit 1
}

if [[ "$MODE" != "--capture" && "$MODE" != "--expect-phase0" ]]; then
  echo "usage: $0 --capture|--expect-phase0" >&2
  exit 2
fi

for command in aws helm jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -f "$CONTRACT" ]] || fail "runtime Secret contract is missing"

verify_asklake_eks_context

cluster_status="$(aws eks describe-cluster \
  --region "$REGION" --name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --query 'cluster.status' --output text)"

nodes="$(kubectl get nodes -o json | jq '{
  count: (.items | length),
  ready: ([.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length),
  amd64: ([.items[] | select(.status.nodeInfo.architecture == "amd64")] | length)
}')"

web="$(kubectl get deployment frontend fastapi -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  steady: ([.items[] | select(
    (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.availableReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
    and (.spec.template.spec.containers[0].image | test("@sha256:[0-9a-f]{64}$"))
  )] | length)
}')"

airflow_deployments="$(kubectl get deployment \
  asklake-airflow-apiserver asklake-airflow-scheduler asklake-airflow-dag-processor \
  -n "$NAMESPACE" -o json | jq '{
    count: (.items | length),
    steady: ([.items[] | select(
      (.spec.replicas // 0) == 1
      and (.status.readyReplicas // 0) == 1
      and (.status.availableReplicas // 0) == 1
      and (.status.unavailableReplicas // 0) == 0
      and .spec.template.spec.serviceAccountName == "asklake-airflow"
      and (.spec.template.spec.containers[0].image | test("@sha256:[0-9a-f]{64}$"))
    )] | length)
  }')"

airflow_pods="$(kubectl get pods -n "$NAMESPACE" -o json | jq '{
  count: ([.items[] | select(.metadata.name | startswith("asklake-airflow-"))] | length),
  runningReady: ([.items[] | select(
    (.metadata.name | startswith("asklake-airflow-"))
    and .status.phase == "Running"
    and all(.status.containerStatuses[]?; .ready == true)
  )] | length),
  restartTotal: ([.items[]
    | select(.metadata.name | startswith("asklake-airflow-"))
    | .status.containerStatuses[]?.restartCount
  ] | add // 0)
}')"

airflow_health="$(kubectl exec -n "$NAMESPACE" deployment/frontend -- \
  sh -c 'wget -qO- http://airflow-apiserver:8080/api/v2/monitor/health' | jq '{
    metadatabase: (.metadatabase.status == "healthy"),
    scheduler: (.scheduler.status == "healthy"),
    dagProcessor: (.dag_processor.status == "healthy")
  }')"

service_accounts="$(kubectl get serviceaccount -n "$NAMESPACE" -o json | jq '
  ["asklake-frontend", "asklake-backend", "asklake-airflow", "asklake-msk-smoke", "asklake-spark", "asklake-trino"] as $expected
  | {
      expected: ($expected | length),
      present: ([.items[].metadata.name | select(. as $name | $expected | index($name))] | length),
      airflowTokenDisabled: ([.items[] | select(.metadata.name == "asklake-airflow")][0].automountServiceAccountToken == false)
    }
')"

secret_status='{}'
for name in asklake-backend-runtime asklake-airflow-runtime asklake-spark-runtime asklake-trino-runtime; do
  state="missing"
  kubectl get secret "$name" -n "$NAMESPACE" >/dev/null 2>&1 && state="present"
  secret_status="$(jq -c --arg name "$name" --arg state "$state" '. + {($name): $state}' <<<"$secret_status")"
done

source_status='{}'
for component in backend airflow spark trino; do
  state="missing"
  aws secretsmanager describe-secret --region "$REGION" \
    --secret-id "asklake/dev/$component/runtime" >/dev/null 2>&1 && state="present"
  source_status="$(jq -c --arg name "$component" --arg state "$state" '. + {($name): $state}' <<<"$source_status")"
done

external_secrets="$(kubectl get externalsecret -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  ready: ([.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length),
  names: ([.items[].metadata.name] | sort)
}')"

secret_contract="$(kubectl get secret asklake-backend-runtime asklake-airflow-runtime \
  -n "$NAMESPACE" -o json | jq --slurpfile contract "$CONTRACT" '{
    backendKeys: ([.items[] | select(.metadata.name == "asklake-backend-runtime")][0].data | keys | sort),
    airflowKeys: ([.items[] | select(.metadata.name == "asklake-airflow-runtime")][0].data | keys | sort),
    expectedAirflowKeys: ($contract[0].secrets.airflow.keys | sort),
    airflowKeysMatchContract: (
      ([.items[] | select(.metadata.name == "asklake-airflow-runtime")][0].data | keys | sort)
      == ($contract[0].secrets.airflow.keys | sort)
    ),
    airflowExtraKeys: (
      ([.items[] | select(.metadata.name == "asklake-airflow-runtime")][0].data | keys)
      - $contract[0].secrets.airflow.keys | sort
    ),
    backendOwnedByExternalSecret: any(
      [.items[] | select(.metadata.name == "asklake-backend-runtime")][0].metadata.ownerReferences[]?;
      .kind == "ExternalSecret" and .controller == true
    ),
    airflowOwnedByExternalSecret: any(
      [.items[] | select(.metadata.name == "asklake-airflow-runtime")][0].metadata.ownerReferences[]?;
      .kind == "ExternalSecret" and .controller == true
    )
  }')"

backend_source="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id asklake/dev/backend/runtime --query SecretString --output text)"
airflow_source="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id asklake/dev/airflow/runtime --query SecretString --output text)"
backend_target="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json \
  | jq -c '.data | with_entries(.value |= @base64d)')"
airflow_target="$(kubectl get secret asklake-airflow-runtime -n "$NAMESPACE" -o json \
  | jq -c '.data | with_entries(.value |= @base64d)')"

backend_hash_match=false
airflow_hash_match=false
[[ "$(jq -S -c . <<<"$backend_source" | asklake_sha256)" == \
   "$(jq -S -c . <<<"$backend_target" | asklake_sha256)" ]] && backend_hash_match=true
[[ "$(jq -S -c . <<<"$airflow_source" | asklake_sha256)" == \
   "$(jq -S -c . <<<"$airflow_target" | asklake_sha256)" ]] && airflow_hash_match=true
shared_airflow_bindings_match="$(jq -n \
  --argjson backend "$backend_source" --argjson airflow "$airflow_source" '
    ["AIRFLOW_EXECUTION_API_TOKEN", "AIRFLOW_INTERNAL_TOKEN"] as $keys
    | all($keys[]; ($backend[.] // null) != null and $backend[.] == $airflow[.])
  ')"
unset backend_source airflow_source backend_target airflow_target

secret_read_checks='[]'
for service_account in asklake-frontend asklake-backend asklake-airflow \
  asklake-msk-smoke asklake-spark asklake-trino; do
  check_status=0
  answer="$(kubectl auth can-i get secrets -n "$NAMESPACE" \
    --as="system:serviceaccount:$NAMESPACE:$service_account" 2>/dev/null)" || check_status=$?
  secret_read_checks="$(jq -c \
    --arg serviceAccount "$service_account" --arg answer "$answer" \
    --argjson exitCode "$check_status" \
    '. + [{serviceAccount: $serviceAccount, answer: $answer, exitCode: $exitCode}]' \
    <<<"$secret_read_checks")"
done

pod_identity_associations="$(aws eks list-pod-identity-associations \
  --region "$REGION" --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --output json \
  | jq --arg namespace "$NAMESPACE" '
    [.associations[]? | select(.namespace == $namespace) | .serviceAccount] as $accounts
    | {
        backend: ([$accounts[] | select(. == "asklake-backend")] | length),
        mskSmoke: ([$accounts[] | select(. == "asklake-msk-smoke")] | length),
        spark: ([$accounts[] | select(. == "asklake-spark")] | length),
        trino: ([$accounts[] | select(. == "asklake-trino")] | length),
        airflow: ([$accounts[] | select(. == "asklake-airflow")] | length)
      }
  ')"

msk_cluster_arn="$(aws kafka list-clusters-v2 --region "$REGION" \
  --cluster-type SERVERLESS --output json | jq -r '
    [.ClusterInfoList[]? | select(.State == "ACTIVE")]
    | if length == 1 then .[0].ClusterArn else "" end
  ')"
[[ -n "$msk_cluster_arn" ]] || fail "exactly one active MSK Serverless cluster is required"
active_msk_brokers="$(aws kafka get-bootstrap-brokers --region "$REGION" \
  --cluster-arn "$msk_cluster_arn" --query BootstrapBrokerStringSaslIam --output text \
  | tr ',' '\n' | LC_ALL=C sort -u)"
runtime_msk_brokers="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json \
  | jq -r '.data.ASKLAKE_KAFKA_BROKER // ""' | tr ',' '\n' | LC_ALL=C sort -u)"
msk_runtime_match=false
[[ -n "$runtime_msk_brokers" && "$runtime_msk_brokers" == "$active_msk_brokers" ]] && \
  msk_runtime_match=true
unset msk_cluster_arn active_msk_brokers runtime_msk_brokers

spark_operator="$(jq -n \
  --argjson crdEstablished "$(kubectl get crd sparkapplications.sparkoperator.k8s.io -o json \
    | jq 'any(.status.conditions[]?; .type == "Established" and .status == "True")')" \
  --argjson readyDeployments "$(kubectl get deployment -n spark-operator -o json \
    | jq '[.items[] | select((.spec.replicas // 0) > 0 and (.status.readyReplicas // 0) == (.spec.replicas // 0))] | length')" \
  --argjson sparkApplications "$(kubectl get sparkapplications.sparkoperator.k8s.io -n "$NAMESPACE" -o json \
    | jq '.items | length')" \
  '{crdEstablished: $crdEstablished, readyDeployments: $readyDeployments, sparkApplications: $sparkApplications}')"

trino_deployments="$(kubectl get deployment -n "$NAMESPACE" -o json \
  | jq '[.items[] | select(.metadata.name | contains("trino"))] | length')"

ecr="$(aws ecr describe-repositories --region "$REGION" --output json | jq '
  [.repositories[] | select(
    .repositoryName | test("(^|/)asklake/dev/(frontend|backend|airflow|spark-runtime|trino)$")
  )] | {
    count: length,
    immutable: ([.[] | select(
      .imageTagMutability == "IMMUTABLE"
      or .imageTagMutability == "IMMUTABLE_WITH_EXCLUSION"
    )] | length)
  }
')"

rds="$(aws rds describe-db-instances --region "$REGION" --output json | jq '{
  available: ([.DBInstances[] | select(.DBInstanceStatus == "available")] | length)
}')"

alb="$(bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady | jq '{
  state: .albState,
  healthyTargets,
  drainingTargets,
  backendDatabaseOk
}')"

continuous="$(bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" | awk -F= '
  { values[$1] = $2 }
  END {
    printf "{\"controlPlane\":\"%s\",\"processes\":%d}",
      values["eks_continuous_control_plane"], values["eks_continuous_processes"]
  }
')"

running_non_eks_instances="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=instance-state-name,Values=running --output json | jq -r '
    [.Reservations[].Instances[]
      | select(([.Tags[]?.Key] | index("aws:eks:cluster-name")) == null)
      | .InstanceId] | unique[]
  ')"
external_ec2_count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"$running_non_eks_instances")"
external_ec2_healthy=false
if [[ "$external_ec2_count" -eq 1 ]]; then
  ASKLAKE_EXPECTED_EC2_INSTANCE_ID="$running_non_eks_instances" \
    bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null
  external_ec2_healthy=true
fi
unset running_non_eks_instances

helm_releases="$(helm list -A -o json | jq '[.[] | select(
  .name == "asklake-foundation"
  or .name == "asklake-ingress"
  or .name == "asklake-web"
  or .name == "asklake-airflow"
  or .name == "asklake-spark-operator"
  or .name == "external-secrets"
) | {name, namespace, status, revision}] | sort_by(.name)')"
rollback_revisions="$(helm history asklake-web -n "$NAMESPACE" -o json \
  | jq '[.[] | select(.status == "superseded")] | length')"

baseline="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg clusterStatus "$cluster_status" --arg namespace "$NAMESPACE" \
  --argjson nodes "$nodes" --argjson web "$web" \
  --argjson airflowDeployments "$airflow_deployments" \
  --argjson airflowPods "$airflow_pods" --argjson airflowHealth "$airflow_health" \
  --argjson serviceAccounts "$service_accounts" --argjson secretStatus "$secret_status" \
  --argjson sourceStatus "$source_status" --argjson externalSecrets "$external_secrets" \
  --argjson secretContract "$secret_contract" --argjson backendHashMatch "$backend_hash_match" \
  --argjson airflowHashMatch "$airflow_hash_match" \
  --argjson sharedAirflowBindingsMatch "$shared_airflow_bindings_match" \
  --argjson secretReadChecks "$secret_read_checks" \
  --argjson podIdentityAssociations "$pod_identity_associations" \
  --argjson mskRuntimeMatch "$msk_runtime_match" --argjson sparkOperator "$spark_operator" \
  --argjson trinoDeployments "$trino_deployments" --argjson ecr "$ecr" \
  --argjson rds "$rds" --argjson alb "$alb" --argjson continuous "$continuous" \
  --argjson externalEc2Count "$external_ec2_count" \
  --argjson externalEc2Healthy "$external_ec2_healthy" \
  --argjson helmReleases "$helm_releases" --argjson rollbackRevisions "$rollback_revisions" '
  {
    capturedAt: $capturedAt,
    cluster: {status: $clusterStatus, namespace: $namespace},
    nodes: $nodes,
    web: $web,
    airflow: {deployments: $airflowDeployments, pods: $airflowPods, health: $airflowHealth},
    foundation: {
      serviceAccounts: $serviceAccounts,
      podIdentityAssociations: $podIdentityAssociations,
      sparkOperator: $sparkOperator
    },
    secretDelivery: {
      kubernetesSecrets: $secretStatus,
      secretsManagerSources: $sourceStatus,
      externalSecrets: $externalSecrets,
      contract: $secretContract,
      backendSourceTargetHashMatch: $backendHashMatch,
      airflowSourceTargetHashMatch: $airflowHashMatch,
      sharedAirflowBindingsMatch: $sharedAirflowBindingsMatch,
      applicationSecretReadChecks: $secretReadChecks
    },
    dataPlane: {
      mskRuntimeEndpointMatchesActiveServerless: $mskRuntimeMatch,
      trinoDeployments: $trinoDeployments,
      ecr: $ecr,
      rds: $rds
    },
    currentRuntime: {
      alb: $alb,
      continuous: $continuous,
      externalEc2Count: $externalEc2Count,
      externalEc2Healthy: $externalEc2Healthy
    },
    rollback: {webSupersededRevisions: $rollbackRevisions},
    helmReleases: $helmReleases
  }
')"

if [[ "$MODE" == "--expect-phase0" ]]; then
  jq -e '
    .cluster.status == "ACTIVE"
    and .nodes.count >= 1 and .nodes.ready == .nodes.count and .nodes.amd64 == .nodes.count
    and .web == {count: 2, steady: 2}
    and .airflow.deployments == {count: 3, steady: 3}
    and .airflow.pods.count == 3 and .airflow.pods.runningReady == 3
    and .airflow.pods.restartTotal == 0 and all(.airflow.health[]; . == true)
    and .foundation.serviceAccounts.expected == 6
    and .foundation.serviceAccounts.present == 6
    and .foundation.serviceAccounts.airflowTokenDisabled == true
    and .foundation.podIdentityAssociations == {backend: 1, mskSmoke: 1, spark: 1, trino: 1, airflow: 0}
    and .foundation.sparkOperator == {crdEstablished: true, readyDeployments: 2, sparkApplications: 0}
    and .secretDelivery.kubernetesSecrets == {
      "asklake-backend-runtime": "present", "asklake-airflow-runtime": "present",
      "asklake-spark-runtime": "missing", "asklake-trino-runtime": "missing"
    }
    and .secretDelivery.secretsManagerSources == {
      backend: "present", airflow: "present", spark: "missing", trino: "missing"
    }
    and .secretDelivery.externalSecrets.count == 2
    and .secretDelivery.externalSecrets.ready == 2
    and .secretDelivery.backendSourceTargetHashMatch == true
    and .secretDelivery.airflowSourceTargetHashMatch == true
    and .secretDelivery.sharedAirflowBindingsMatch == true
    and .secretDelivery.contract.airflowKeysMatchContract == false
    and .secretDelivery.contract.airflowExtraKeys == ["AIRFLOW_PASSWORD"]
    and all(.secretDelivery.applicationSecretReadChecks[]; .answer == "no" and .exitCode == 1)
    and .dataPlane.mskRuntimeEndpointMatchesActiveServerless == true
    and .dataPlane.trinoDeployments == 0
    and .dataPlane.ecr == {count: 5, immutable: 5}
    and .dataPlane.rds.available >= 1
    and .currentRuntime.alb.state == "active"
    and .currentRuntime.alb.healthyTargets == 4
    and .currentRuntime.alb.drainingTargets == 0
    and .currentRuntime.alb.backendDatabaseOk == true
    and .currentRuntime.continuous == {controlPlane: "external_ec2", processes: 0}
    and .currentRuntime.externalEc2Count == 1
    and .currentRuntime.externalEc2Healthy == true
    and .rollback.webSupersededRevisions >= 1
    and all(.helmReleases[]; .status == "deployed")
  ' <<<"$baseline" >/dev/null
  echo "EKS day16 A Phase 0 baseline passed." >&2
fi

printf '%s\n' "$baseline"
