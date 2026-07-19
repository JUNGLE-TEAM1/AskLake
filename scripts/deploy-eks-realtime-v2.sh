#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:-}"
VALUES_FILE="${2:-}"
IMAGE_RECEIPT="${3:-}"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane"
RELEASE="asklake-realtime-v2"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
TEMP_DIR="$(mktemp -d)"
RENDERED_FILE="$TEMP_DIR/rendered.yaml"
OBJECTS_FILE="$TEMP_DIR/objects.json"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "$1" >&2
  exit 1
}

usage() {
  echo "usage: $0 --render|--preflight|--apply <private-values.yaml> <realtime-v2-image-receipt.json>" >&2
}

if [[ ! "$MODE" =~ ^--(render|preflight|apply)$ ]] \
  || [[ ! -s "$VALUES_FILE" ]] \
  || [[ ! -s "$IMAGE_RECEIPT" ]]; then
  usage
  exit 2
fi

for command in aws git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

bash "$ROOT_DIR/scripts/verify-eks-realtime-data-plane.sh" >&2
node "$ROOT_DIR/scripts/verify-eks-realtime-v2-image-receipt.mjs" "$IMAGE_RECEIPT" >&2
helm lint "$CHART_DIR" -f "$VALUES_FILE" >&2
helm template "$RELEASE" "$CHART_DIR" --namespace "$NAMESPACE" \
  -f "$VALUES_FILE" >"$RENDERED_FILE"
kubectl create --dry-run=client -f "$RENDERED_FILE" -o json \
  | jq -s '.' >"$OBJECTS_FILE"

jq -e '
  ([.[] | select(.kind == "StatefulSet")] | length) == 2
  and ([.[] | select(.kind == "Deployment" and .metadata.name == "kafka-connect-v2")] | length) == 1
  and ([.[] | select(.kind == "Service" and .metadata.name == "clickhouse-v2")] | length) == 1
  and ([.[] | select(.kind == "Service" and .metadata.name == "clickhouse-keeper-v2")] | length) == 1
' "$OBJECTS_FILE" >/dev/null || fail "candidate must render the canonical V2 stateful data-plane identities"

rendered_clickhouse_image="$(jq -r '
  .[] | select(.kind == "StatefulSet" and .metadata.name == "clickhouse-v2")
  | .spec.template.spec.containers[] | select(.name == "clickhouse") | .image
' "$OBJECTS_FILE")"
rendered_keeper_image="$(jq -r '
  .[] | select(.kind == "StatefulSet" and .metadata.name == "clickhouse-keeper-v2")
  | .spec.template.spec.containers[] | select(.name == "keeper") | .image
' "$OBJECTS_FILE")"
rendered_connect_image="$(jq -r '
  .[] | select(.kind == "Deployment" and .metadata.name == "kafka-connect-v2")
  | .spec.template.spec.containers[] | select(.name == "kafka-connect") | .image
' "$OBJECTS_FILE")"
rendered_worker_image="$(jq -r '
  [.[] | select(.kind == "Deployment" and .metadata.name == "asklake-continuous-worker")
  | .spec.template.spec.containers[] | select(.name == "continuous-worker") | .image][0] // ""
' "$OBJECTS_FILE")"

receipt_clickhouse_image="$(jq -r '.images.clickhouse' "$IMAGE_RECEIPT")"
receipt_connect_image="$(jq -r '.images.kafkaConnect' "$IMAGE_RECEIPT")"
receipt_backend_image="$(jq -r '.images.backend' "$IMAGE_RECEIPT")"
[[ "$rendered_clickhouse_image" == "$receipt_clickhouse_image" \
  && "$rendered_keeper_image" == "$receipt_clickhouse_image" ]] \
  || fail "rendered ClickHouse/Keeper image does not match the verified receipt"
[[ "$rendered_connect_image" == "$receipt_connect_image" ]] \
  || fail "rendered Kafka Connect image does not match the verified receipt"
if [[ -n "$rendered_worker_image" && "$rendered_worker_image" != "$receipt_backend_image" ]]; then
  fail "rendered Continuous worker image does not match the verified receipt"
fi

if [[ "$MODE" == "--render" ]]; then
  cat "$RENDERED_FILE"
  exit 0
fi

verify_asklake_eks_context
[[ "$ASKLAKE_VERIFIED_EKS_NAMESPACE" == "$NAMESPACE" ]] \
  || fail "verified namespace does not match the realtime candidate"

for workload in \
  'statefulset:clickhouse-keeper-v2' \
  'statefulset:clickhouse-v2' \
  'deployment:kafka-connect-v2' \
  'service:clickhouse-keeper-v2' \
  'service:clickhouse-v2' \
  'service:kafka-connect-v2'; do
  IFS=: read -r kind name <<<"$workload"
  if live_object="$(kubectl get "$kind" "$name" -n "$NAMESPACE" -o json 2>/dev/null)"; then
    live_selector="$(jq -S -c '.spec.selector' <<<"$live_object")"
    rendered_selector="$(jq -S -c --arg kind "$kind" --arg name "$name" '
      .[]
      | select((.kind | ascii_downcase) == $kind and .metadata.name == $name)
      | .spec.selector
    ' "$OBJECTS_FILE")"
    [[ -n "$rendered_selector" && "$rendered_selector" == "$live_selector" ]] \
      || fail "candidate selector differs from the live legacy identity: $kind/$name"
  fi
done

receipt_commit="$(jq -r '.gitRevision' "$IMAGE_RECEIPT")"
git -C "$ROOT_DIR" merge-base --is-ancestor "$receipt_commit" HEAD \
  || fail "realtime image receipt revision is not contained in the current branch"
python3 "$ROOT_DIR/scripts/refactor_audit/control_plane_ownership.py" >/dev/null
kubectl get configmap asklake-runtime -n "$NAMESPACE" >/dev/null \
  || fail "foundation-owned asklake-runtime ConfigMap is absent"
kubectl get secret asklake-backend-runtime -n "$NAMESPACE" >/dev/null \
  || fail "foundation-owned asklake-backend-runtime Secret is absent"

jq -e '
  ([.workloads[] | select(.active == true and (.ownsControlPlanes | index("kafka-continuous-runtime-sync"))) | .id] == ["eks-realtime-v1-worker"])
  and ([.workloads[] | select(.active == true and (.ownsControlPlanes | index("continuous-sql-runtime-sync"))) | .id] == ["eks-realtime-v2-worker"])
  and ([.workloads[] | select(.id == "ec2-continuous-worker") | .active] == [false])
' "$ROOT_DIR/deploy/control-plane-ownership.json" >/dev/null \
  || fail "canonical control-plane manifest does not declare V1 Kafka, V2 Continuous SQL, and EC2 quiesce"

v1_deployment="$(kubectl get deployment asklake-realtime-v1-worker -n "$NAMESPACE" -o json)"
jq -e '
  .spec.replicas == 1
  and .status.readyReplicas == 1
  and ([.spec.template.spec.containers[].env[]? | select(.name == "CONTINUOUS_WORKER_SCOPE") | .value] == ["kafka"])
  and ([.spec.template.spec.containers[].env[]? | select(.name == "CONTINUOUS_WORKER_OWNER") | .value] == ["eks-continuous-worker-v1"])
' <<<"$v1_deployment" >/dev/null || fail "EKS Realtime V1 is not the single ready Kafka owner"

cluster_deployments="$(kubectl get deployments -n "$NAMESPACE" -o json)"
jq -e '
  [.items[]
    | select((.spec.replicas // 0) > 0)
    | . as $deployment
    | [.spec.template.spec.containers[].env[]?
        | select(.name == "CONTINUOUS_WORKER_SCOPE")
        | .value] as $scopes
    | select(($scopes | index("kafka")) or ($scopes | index("all")))
    | $deployment.metadata.name] == ["asklake-realtime-v1-worker"]
' <<<"$cluster_deployments" >/dev/null \
  || fail "EKS must have exactly one desired Kafka/all-scope loop: asklake-realtime-v1-worker"

kafka_connect_service_account="$(jq -r '
  .[] | select(.kind == "Deployment" and .metadata.name == "kafka-connect-v2")
  | .spec.template.spec.serviceAccountName
' "$OBJECTS_FILE")"
[[ "$kafka_connect_service_account" == "asklake-realtime-v2-connect" ]] \
  || fail "Kafka Connect V2 must preserve the legacy Pod Identity ServiceAccount"
if jq -e --arg serviceAccount "$kafka_connect_service_account" '
  any(.[]; .kind == "ServiceAccount" and .metadata.name == $serviceAccount)
' "$OBJECTS_FILE" >/dev/null; then
  existing_service_account="$(kubectl get serviceaccount "$kafka_connect_service_account" \
    -n "$NAMESPACE" -o json 2>/dev/null || true)"
  if [[ -n "$existing_service_account" ]]; then
    jq -e --arg release "$RELEASE" '
      .metadata.annotations["meta.helm.sh/release-name"] == $release
    ' <<<"$existing_service_account" >/dev/null \
      || fail "rendered Kafka Connect ServiceAccount already exists outside the canonical Helm release; set createServiceAccount=false"
  fi
else
  kubectl get serviceaccount "$kafka_connect_service_account" -n "$NAMESPACE" >/dev/null \
    || fail "externally managed Kafka Connect V2 ServiceAccount is absent"
fi

associations="$(aws eks list-pod-identity-associations \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --region "$REGION" --output json)"
association_id="$(jq -r --arg namespace "$NAMESPACE" --arg serviceAccount "$kafka_connect_service_account" '
  [.associations[]? | select(
    .namespace == $namespace
    and .serviceAccount == $serviceAccount
  ) | .associationId] as $ids
  | if ($ids | length) == 1 then $ids[0] else "" end
' <<<"$associations")"
[[ -n "$association_id" ]] || fail "Kafka Connect V2 requires exactly one EKS Pod Identity association"
association="$(aws eks describe-pod-identity-association \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --association-id "$association_id" \
  --region "$REGION" --output json)"
role_arn="$(jq -r '.association.roleArn // ""' <<<"$association")"
[[ "$role_arn" =~ ^arn:[^:]+:iam::[0-9]{12}:role/.+ ]] \
  || fail "Kafka Connect V2 Pod Identity association has no valid role"
role_name="${role_arn##*/}"
policy_arns="$(aws iam list-attached-role-policies --role-name "$role_name" --output json \
  | jq -r '.AttachedPolicies[].PolicyArn')"
[[ -n "$policy_arns" ]] || fail "Kafka Connect V2 Pod Identity role has no attached policy"
: >"$TEMP_DIR/kafka-connect-policy-documents.jsonl"
while IFS= read -r policy_arn; do
  [[ -n "$policy_arn" ]] || continue
  default_version="$(aws iam get-policy --policy-arn "$policy_arn" \
    --query 'Policy.DefaultVersionId' --output text)"
  aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$default_version" \
    --query 'PolicyVersion.Document' --output json >>"$TEMP_DIR/kafka-connect-policy-documents.jsonl"
done <<<"$policy_arns"
bash "$ROOT_DIR/scripts/verify-eks-realtime-v2-secrets.sh" "$NAMESPACE" "$TEMP_DIR/secrets" >&2

jq -s '.' "$TEMP_DIR/kafka-connect-policy-documents.jsonl" \
  >"$TEMP_DIR/kafka-connect-policy-documents.json"
jq '[
  .data.CONNECT_CONFIG_STORAGE_TOPIC,
  .data.CONNECT_OFFSET_STORAGE_TOPIC,
  .data.CONNECT_STATUS_STORAGE_TOPIC
] | map(@base64d)' \
  "$TEMP_DIR/secrets/asklake-kafka-connect-v2-runtime-secret.json" \
  >"$TEMP_DIR/kafka-connect-internal-topics.json"
jq '[.data.ASKLAKE_V2_SOURCE_TOPIC | @base64d]' \
  "$TEMP_DIR/secrets/asklake-kafka-connect-v2-runtime-secret.json" \
  >"$TEMP_DIR/kafka-connect-source-topics.json"

kubectl get --raw \
  "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors" \
  >"$TEMP_DIR/kafka-connect-connector-names.json"
jq -e 'type == "array" and all(.[]; test("^[A-Za-z0-9._-]+$"))' \
  "$TEMP_DIR/kafka-connect-connector-names.json" >/dev/null \
  || fail "Kafka Connect returned an invalid connector-name list"
: >"$TEMP_DIR/kafka-connect-connectors.jsonl"
while IFS= read -r connector_name; do
  [[ -n "$connector_name" ]] || continue
  kubectl get --raw \
    "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors/$connector_name/config" \
    >"$TEMP_DIR/kafka-connect-connector-config.json"
  kubectl get --raw \
    "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors/$connector_name/status" \
    >"$TEMP_DIR/kafka-connect-connector-status.json"
  jq -n --arg name "$connector_name" \
    --slurpfile config "$TEMP_DIR/kafka-connect-connector-config.json" \
    --slurpfile status "$TEMP_DIR/kafka-connect-connector-status.json" \
    '{name:$name, config:$config[0], status:$status[0]}' \
    >>"$TEMP_DIR/kafka-connect-connectors.jsonl"
done < <(jq -r '.[]' "$TEMP_DIR/kafka-connect-connector-names.json")
jq -s '.' "$TEMP_DIR/kafka-connect-connectors.jsonl" \
  >"$TEMP_DIR/kafka-connect-connectors.json"
jq -n \
  --slurpfile policies "$TEMP_DIR/kafka-connect-policy-documents.json" \
  --slurpfile internalTopics "$TEMP_DIR/kafka-connect-internal-topics.json" \
  --slurpfile sourceTopics "$TEMP_DIR/kafka-connect-source-topics.json" \
  --slurpfile connectors "$TEMP_DIR/kafka-connect-connectors.json" \
  '{
    requireRunning:false,
    policyDocuments:$policies[0],
    internalTopics:$internalTopics[0],
    sourceTopics:$sourceTopics[0],
    connectors:$connectors[0]
  }' >"$TEMP_DIR/kafka-connect-live-contract.json"
chmod 600 "$TEMP_DIR"/kafka-connect-*.json "$TEMP_DIR"/kafka-connect-*.jsonl
node "$ROOT_DIR/scripts/verify-eks-realtime-v2-kafka-contract.mjs" \
  "$TEMP_DIR/kafka-connect-live-contract.json" >&2

for identity in \
  'clickhouse-v2:clickhouse-data:clickhouse-data-clickhouse-v2-0' \
  'clickhouse-keeper-v2:keeper-data:keeper-data-clickhouse-keeper-v2-0'; do
  IFS=: read -r statefulset_name claim_name pvc_name <<<"$identity"
  expected_size="$(jq -r --arg sts "$statefulset_name" --arg claim "$claim_name" '
    .[] | select(.kind == "StatefulSet" and .metadata.name == $sts)
    | .spec.volumeClaimTemplates[] | select(.metadata.name == $claim)
    | .spec.resources.requests.storage
  ' "$OBJECTS_FILE")"
  expected_class="$(jq -r --arg sts "$statefulset_name" --arg claim "$claim_name" '
    .[] | select(.kind == "StatefulSet" and .metadata.name == $sts)
    | .spec.volumeClaimTemplates[] | select(.metadata.name == $claim)
    | .spec.storageClassName
  ' "$OBJECTS_FILE")"
  pvc="$(kubectl get pvc "$pvc_name" -n "$NAMESPACE" -o json)"
  jq -e --arg size "$expected_size" --arg storageClass "$expected_class" '
    .status.phase == "Bound"
    and .spec.resources.requests.storage == $size
    and .spec.storageClassName == $storageClass
    and .metadata.ownerReferences == null
  ' <<<"$pvc" >/dev/null || fail "retained PVC does not match candidate size/class/ownership: $pvc_name"
done

snapshots="$(kubectl get volumesnapshot -n "$NAMESPACE" -o json)"
for pvc_name in clickhouse-data-clickhouse-v2-0 keeper-data-clickhouse-keeper-v2-0; do
  jq -e --arg pvc "$pvc_name" '
    any(.items[]?; .spec.source.persistentVolumeClaimName == $pvc and .status.readyToUse == true)
  ' <<<"$snapshots" >/dev/null || fail "no Ready VolumeSnapshot protects retained PVC: $pvc_name"
done

for image in "$receipt_clickhouse_image" "$receipt_connect_image" "$receipt_backend_image"; do
  repository_uri="${image%@*}"
  repository_name="${repository_uri#*/}"
  digest="${image##*@}"
  aws ecr describe-images --region "$REGION" --repository-name "$repository_name" \
    --image-ids "imageDigest=$digest" --query 'imageDetails[0].imageDigest' --output text \
    | grep -Fx "$digest" >/dev/null || fail "receipt image digest is absent from ECR"
done

release_before="$(helm list -n "$NAMESPACE" -o json | jq -r --arg release "$RELEASE" '.[] | select(.name == $release) | .revision')"
[[ "$release_before" =~ ^[0-9]+$ ]] || fail "existing canonical realtime Helm release is required"
chart_before="$(helm list -n "$NAMESPACE" -o json | jq -r --arg release "$RELEASE" '.[] | select(.name == $release) | .chart')"
if [[ "$chart_before" == asklake-workloads-* ]]; then
  helm get values "$RELEASE" -n "$NAMESPACE" -o json \
    | jq -e '.realtimeV2.enabled == false' >/dev/null \
    || fail "legacy realtime V2 resources must be disabled before canonical chart migration"
elif [[ "$chart_before" != asklake-realtime-data-plane-* ]]; then
  fail "unexpected chart owns the canonical realtime V2 release"
fi

helm upgrade --install "$RELEASE" "$CHART_DIR" --namespace "$NAMESPACE" \
  --create-namespace=false -f "$VALUES_FILE" --dry-run=server >/dev/null
release_after_dry_run="$(helm list -n "$NAMESPACE" -o json | jq -r --arg release "$RELEASE" '.[] | select(.name == $release) | .revision')"
[[ "$release_after_dry_run" == "$release_before" ]] || fail "server dry-run changed the realtime Helm revision"

echo "EKS realtime V2 canonical ownership, V1 preservation, Secret/TLS, PVC/snapshot, image, and server dry-run preflight passed."
if [[ "$MODE" == "--preflight" ]]; then
  exit 0
fi

values_absolute="$(cd "$(dirname "$VALUES_FILE")" && pwd)/$(basename "$VALUES_FILE")"
receipt_absolute="$(cd "$(dirname "$IMAGE_RECEIPT")" && pwd)/$(basename "$IMAGE_RECEIPT")"
case "$values_absolute" in
  "$ROOT_DIR"/*) fail "repository values cannot be applied; use a reviewed private values file" ;;
esac
case "$receipt_absolute" in
  "$ROOT_DIR"/*)
    git -C "$ROOT_DIR" check-ignore -q -- "$receipt_absolute" \
      || fail "repository-local rollout receipt must be ignored by Git"
    ;;
esac
if [[ "${ASKLAKE_REALTIME_V2_APPLY_CONFIRM:-}" != "deploy-reviewed-realtime-v2" ]]; then
  fail "set ASKLAKE_REALTIME_V2_APPLY_CONFIRM=deploy-reviewed-realtime-v2 after explicit approval"
fi
if [[ -n "$rendered_worker_image" \
  && "${ASKLAKE_EC2_CONTROL_LOOP_QUIESCED_CONFIRM:-}" != "ec2-control-loop-zero" ]]; then
  fail "cutover requires ASKLAKE_EC2_CONTROL_LOOP_QUIESCED_CONFIRM=ec2-control-loop-zero"
fi

pvc_uids_before="$(kubectl get pvc clickhouse-data-clickhouse-v2-0 keeper-data-clickhouse-keeper-v2-0 \
  -n "$NAMESPACE" -o json | jq -r '.items[] | [.metadata.name,.metadata.uid] | @tsv' | LC_ALL=C sort)"
helm upgrade --install "$RELEASE" "$CHART_DIR" --namespace "$NAMESPACE" \
  --create-namespace=false -f "$VALUES_FILE" --atomic --wait --timeout 15m
kubectl rollout status statefulset/clickhouse-keeper-v2 statefulset/clickhouse-v2 \
  deployment/kafka-connect-v2 -n "$NAMESPACE" --timeout=15m
if [[ -n "$rendered_worker_image" ]]; then
  kubectl rollout status deployment/asklake-continuous-worker -n "$NAMESPACE" --timeout=10m
fi
pvc_uids_after="$(kubectl get pvc clickhouse-data-clickhouse-v2-0 keeper-data-clickhouse-keeper-v2-0 \
  -n "$NAMESPACE" -o json | jq -r '.items[] | [.metadata.name,.metadata.uid] | @tsv' | LC_ALL=C sort)"
[[ "$pvc_uids_after" == "$pvc_uids_before" ]] || fail "realtime rollout replaced a retained PVC"

echo "EKS realtime V2 release is ready and retained PVC UIDs are unchanged. FastAPI opt-in and GOLD E2E remain separate approval-gated steps."
