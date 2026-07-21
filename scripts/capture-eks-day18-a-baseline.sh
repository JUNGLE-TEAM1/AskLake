#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
OUTPUT="${ASKLAKE_DAY18_BASELINE_OUTPUT:-/private/tmp/asklake-day18-a-phase0-baseline.json}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "${1:---capture}" == "--capture" ]] || fail "usage: $0 --capture"
for command in aws git helm jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ ! -e "$OUTPUT" ]] || fail "refusing to overwrite existing baseline: $OUTPUT"

if [[ -z "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]]; then
  if command -v terraform >/dev/null 2>&1; then
    ASKLAKE_EKS_CLUSTER_NAME="$(terraform -chdir="$ROOT_DIR/infra/eks/terraform" output -raw cluster_name)"
  elif [[ -f "$ROOT_DIR/infra/eks/terraform/terraform.tfstate" ]]; then
    ASKLAKE_EKS_CLUSTER_NAME="$(jq -er '.outputs.cluster_name.value' \
      "$ROOT_DIR/infra/eks/terraform/terraform.tfstate")"
  else
    fail "ASKLAKE_EKS_CLUSTER_NAME or a local Terraform output is required"
  fi
  export ASKLAKE_EKS_CLUSTER_NAME
fi
verify_asklake_eks_context

source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
dev_sha="$(git -C "$ROOT_DIR" rev-parse origin/dev)"
source_contains_dev=false
git -C "$ROOT_DIR" merge-base --is-ancestor "$dev_sha" "$source_sha" && source_contains_dev=true

cluster="$(aws eks describe-cluster --region "$REGION" --name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --query 'cluster.{status:status,logging:logging.clusterLogging}' --output json | jq '{
    status,
    enabledControlPlaneLogTypes: ([.logging[]? | select(.enabled == true) | .types[]?] | unique | sort)
  }')"

addons="$(aws eks list-addons --region "$REGION" --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --output json | jq '{
    count: (.addons | length),
    observabilityCandidates: ([.addons[] | select(test("cloudwatch|observability|adot|fluent"; "i"))] | length)
  }')"

nodes="$(kubectl get nodes -o json | jq '{
  count: (.items | length),
  ready: ([.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length),
  amd64: ([.items[] | select(.status.nodeInfo.architecture == "amd64")] | length),
  general: ([.items[] | select(.metadata.labels["karpenter.sh/nodepool"] == "asklake-general")] | length),
  spark: ([.items[] | select(.metadata.labels["karpenter.sh/nodepool"] == "asklake-spark")] | length),
  other: ([.items[] | select(
    (.metadata.labels["karpenter.sh/nodepool"] // "") as $pool |
    $pool != "asklake-general" and $pool != "asklake-spark"
  )] | length)
}')"

workloads="$(kubectl get deployments,statefulsets,pods,jobs -n "$NAMESPACE" -o json | jq '{
  deployments: ([.items[] | select(.kind == "Deployment")] | length),
  deploymentsSteady: ([.items[] | select(.kind == "Deployment" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0) and
    (.status.availableReplicas // 0) == (.spec.replicas // 0) and
    (.status.unavailableReplicas // 0) == 0)] | length),
  statefulSets: ([.items[] | select(.kind == "StatefulSet")] | length),
  statefulSetsSteady: ([.items[] | select(.kind == "StatefulSet" and
    (.status.readyReplicas // 0) == (.spec.replicas // 0))] | length),
  pods: ([.items[] | select(.kind == "Pod")] | length),
  pendingPods: ([.items[] | select(.kind == "Pod" and .status.phase == "Pending")] | length),
  notReadyPods: ([.items[] | select(.kind == "Pod" and .status.phase == "Running" and
    (any(.status.containerStatuses[]?; .ready != true)))] | length),
  terminatingPods: ([.items[] | select(.kind == "Pod" and .metadata.deletionTimestamp != null)] | length),
  activeJobs: ([.items[] | select(.kind == "Job" and (.status.active // 0) > 0)] | length)
}')"

hpa="$(kubectl get hpa -n "$NAMESPACE" -o json | jq '{
  count: (.items | length),
  currentReplicas: ([.items[].status.currentReplicas // 0] | add // 0),
  desiredReplicas: ([.items[].status.desiredReplicas // 0] | add // 0),
  ableToScale: ([.items[] | select(any(.status.conditions[]?; .type == "AbleToScale" and .status == "True"))] | length)
}')"

spark_applications="$(kubectl get sparkapplications.sparkoperator.k8s.io -n "$NAMESPACE" -o json \
  | jq '{count: (.items | length), active: ([.items[] | select((.status.applicationState.state // "") | IN("SUBMITTED", "RUNNING", "PENDING"))] | length)}')"

events="$(kubectl get events -n "$NAMESPACE" -o json | jq --argjson cutoff "$(($(date +%s) - 3600))" '{
  warningLastHour: ([.items[] | select(.type == "Warning") |
    select((((.eventTime // .lastTimestamp // .metadata.creationTimestamp) | fromdateiso8601?) // 0) >= $cutoff)] | length),
  warningReasonsLastHour: ([.items[] | select(.type == "Warning") |
    select((((.eventTime // .lastTimestamp // .metadata.creationTimestamp) | fromdateiso8601?) // 0) >= $cutoff) |
    .reason] | unique | sort)
}')"

daemonsets="$(kubectl get daemonsets -A -o json | jq '{
  count: (.items | length),
  logCollectorCandidates: ([.items[] | select((.metadata.name + " " + .metadata.namespace) |
    test("cloudwatch|fluent|adot|otel|observability"; "i"))] | length)
}')"

log_groups="$(aws logs describe-log-groups --region "$REGION" --output json | jq \
  --arg cluster "$ASKLAKE_EKS_CLUSTER_NAME" '{
    relevant: [.logGroups[] | select(.logGroupName | contains($cluster))],
    relevantCount: ([.logGroups[] | select(.logGroupName | contains($cluster))] | length),
    retentionConfigured: ([.logGroups[] | select(.logGroupName | contains($cluster)) | select(.retentionInDays != null)] | length),
    storedBytes: ([.logGroups[] | select(.logGroupName | contains($cluster)) | (.storedBytes // 0)] | add // 0)
  } | del(.relevant)')"

helm_state="$(helm list -A -o json | jq '{
  askLakeReleaseCount: ([.[] | select(.name | test("asklake|external-secrets|spark-operator"))] | length),
  deployedCount: ([.[] | select((.name | test("asklake|external-secrets|spark-operator")) and .status == "deployed")] | length)
}')"
rollback_revisions="$(helm history asklake-web -n "$NAMESPACE" -o json | jq '[.[] | select(.status == "superseded")] | length')"

images="$(kubectl get deployments,statefulsets -n "$NAMESPACE" -o json | jq '{
  containers: ([.items[].spec.template.spec.containers[].image] | length),
  immutableDigests: ([.items[].spec.template.spec.containers[].image | select(test("@sha256:[0-9a-f]{64}$"))] | length)
}')"

alb="$(bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady | jq '{
  state: .albState,
  healthyTargets,
  drainingTargets,
  backendDatabaseOk
}')"
continuous="$(bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" | awk -F= '
  { values[$1] = $2 }
  END { printf "{\"controlPlane\":\"%s\",\"processes\":%d}",
    values["eks_continuous_control_plane"], values["eks_continuous_processes"] }
')"

running_non_eks_instances="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=instance-state-name,Values=running --output json | jq -r '
    [.Reservations[].Instances[]
      | select(([.Tags[]?.Key] | index("aws:eks:cluster-name")) == null)
      | .InstanceId] | unique[]')"
external_ec2_count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"$running_non_eks_instances")"
external_ec2_healthy=false
if [[ "$external_ec2_count" -eq 1 ]]; then
  ASKLAKE_EXPECTED_EC2_INSTANCE_ID="$running_non_eks_instances" \
    bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null
  external_ec2_healthy=true
fi
unset running_non_eks_instances

baseline="$(jq -n \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg sourceSha "$source_sha" --arg devSha "$dev_sha" \
  --argjson sourceContainsDev "$source_contains_dev" \
  --arg namespace "$NAMESPACE" --argjson cluster "$cluster" --argjson addons "$addons" \
  --argjson nodes "$nodes" --argjson workloads "$workloads" --argjson hpa "$hpa" \
  --argjson sparkApplications "$spark_applications" --argjson events "$events" \
  --argjson daemonSets "$daemonsets" --argjson logGroups "$log_groups" \
  --argjson helm "$helm_state" --argjson rollbackRevisions "$rollback_revisions" \
  --argjson images "$images" --argjson alb "$alb" --argjson continuous "$continuous" \
  --argjson externalEc2Count "$external_ec2_count" --argjson externalEc2Healthy "$external_ec2_healthy" '
  {
    contract: "asklake.eks.day18.a.phase0.v1",
    capturedAt: $capturedAt,
    source: {sha: $sourceSha, devSha: $devSha, containsDev: $sourceContainsDev},
    cluster: ($cluster + {namespace: $namespace, addons: $addons}),
    capacity: {nodes: $nodes, hpa: $hpa},
    runtime: {workloads: $workloads, sparkApplications: $sparkApplications, images: $images, alb: $alb},
    observability: {events: $events, daemonSets: $daemonSets, cloudWatchLogGroups: $logGroups},
    rollback: {
      helm: $helm,
      webSupersededRevisions: $rollbackRevisions,
      externalEc2Count: $externalEc2Count,
      externalEc2Healthy: $externalEc2Healthy,
      continuous: $continuous
    },
    decisions: {
      applicationLogCollector: "UNDECIDED_PHASE1",
      candidates: ["cloudwatch-observability-addon", "fluent-bit", "adot"]
    }
  }')"

mkdir -p "$(dirname "$OUTPUT")"
printf '%s\n' "$baseline" >"$OUTPUT"
chmod 600 "$OUTPUT"

jq -e '
  .contract == "asklake.eks.day18.a.phase0.v1"
  and .source.containsDev == true
  and .cluster.status == "ACTIVE"
  and .capacity.nodes.count >= 1
  and .capacity.nodes.ready == .capacity.nodes.count
  and .runtime.workloads.pendingPods == 0
  and .runtime.workloads.notReadyPods == 0
  and .runtime.workloads.terminatingPods == 0
  and .runtime.workloads.activeJobs == 0
  and .runtime.sparkApplications.active == 0
  and .runtime.images.containers == .runtime.images.immutableDigests
  and .runtime.alb.state == "active"
  and .runtime.alb.drainingTargets == 0
  and .runtime.alb.backendDatabaseOk == true
  and .rollback.webSupersededRevisions >= 1
  and .rollback.externalEc2Count == 1
  and .rollback.externalEc2Healthy == true
  and .rollback.continuous == {controlPlane: "external_ec2", processes: 0}
  and .decisions.applicationLogCollector == "UNDECIDED_PHASE1"
' "$OUTPUT" >/dev/null || fail "Day 18 Phase 0 baseline is not steady; inspect the private receipt"

echo "Day 18 A Phase 0 baseline passed (sanitized receipt, mode 0600)."
