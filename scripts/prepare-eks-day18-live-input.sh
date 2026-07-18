#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EC2_ENV="${ASKLAKE_DAY18_EC2_ENV:-}"
CURRENT_RECEIPT="${ASKLAKE_DAY18_CURRENT_RECEIPT:-}"
OUTPUT="${ASKLAKE_DAY18_LIVE_INPUT:-/private/tmp/asklake-day18-live-input.json}"
COLLECTOR="$ROOT_DIR/scripts/collect-eks-day18-live-input.py"
TEMP_DIR="$(mktemp -d)"
REMOTE="$TEMP_DIR/remote.json"
WORKLOADS="$TEMP_DIR/workloads.json"
HPA="$TEMP_DIR/hpa.json"
LIVE_INPUT="$TEMP_DIR/live-input.json"

fail() {
  echo "$1" >&2
  exit 1
}

portable_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

[[ "${1:---prepare}" == "--prepare" ]] || fail "usage: $0 --prepare"
for command in aws curl jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]] || fail "ASKLAKE_EKS_CLUSTER_NAME must be explicitly set"
[[ -n "$EC2_ENV" && -s "$EC2_ENV" ]] || fail "ASKLAKE_DAY18_EC2_ENV must identify the preserved EC2 env file"
[[ "$(portable_mode "$EC2_ENV")" == "600" ]] || fail "preserved EC2 env file must use mode 0600"
[[ -n "$CURRENT_RECEIPT" && -s "$CURRENT_RECEIPT" ]] || fail "ASKLAKE_DAY18_CURRENT_RECEIPT is required"
[[ "$(portable_mode "$CURRENT_RECEIPT")" == "600" ]] || fail "current image receipt must use mode 0600"
[[ -s "$COLLECTOR" ]] || fail "Day 18 live input collector is missing"
case "$OUTPUT" in
  "$ROOT_DIR"|"$ROOT_DIR"/*) fail "live input must be stored outside the repository" ;;
esac
[[ ! -e "$OUTPUT" ]] || fail "refusing to overwrite an existing live input"

verify_asklake_eks_context
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$CURRENT_RECEIPT" >/dev/null

set -a
source "$EC2_ENV"
set +a
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="${ASKLAKE_EC2_INSTANCE_ID:?preserved EC2 instance ID missing}"
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null

expected_backend_image="$(jq -er '.images.backend' "$CURRENT_RECEIPT")"
expected_backend_digest="${expected_backend_image##*@}"
fastapi="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
collector="$(kubectl get deployment trino-result-collector -n "$NAMESPACE" -o json)"
fastapi_image="$(jq -er '.spec.template.spec.containers[] | select(.name=="fastapi") | .image' <<<"$fastapi")"
collector_image="$(jq -er '.spec.template.spec.containers[] | select(.name=="trino-result-collector") | .image' <<<"$collector")"
[[ "$fastapi_image" == "$expected_backend_image" ]] || fail "FastAPI image does not match the current receipt"
[[ "$collector_image" == "$expected_backend_image" ]] || fail "Collector image does not match the current receipt"
fastapi_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
collector_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=trino-result-collector -o json)"
jq -e --arg digest "$expected_backend_digest" '
  (.items | length) == 2
  and all(.items[];
    .metadata.deletionTimestamp == null
    and .status.phase == "Running"
    and any(.status.containerStatuses[]?;
      .name == "fastapi"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$fastapi_pods" >/dev/null || fail "FastAPI Pod imageID does not match the current receipt"
jq -e --arg digest "$expected_backend_digest" '
  (.items | length) == 1
  and all(.items[];
    .metadata.deletionTimestamp == null
    and .status.phase == "Running"
    and any(.status.containerStatuses[]?;
      .name == "trino-result-collector"
      and .ready == true
      and .restartCount == 0
      and (.imageID | endswith($digest))
    )
  )
' <<<"$collector_pods" >/dev/null || fail "Collector Pod imageID does not match the current receipt"

jq -n \
  --argjson fastapi "$fastapi" \
  --argjson collector "$collector" \
  --argjson pods "$(kubectl get pods -n "$NAMESPACE" -o json)" \
  --argjson jobs "$(kubectl get jobs -n "$NAMESPACE" -o json)" '
  {
    fastApiReady: ($fastapi.status.readyReplicas // 0),
    collectorReady: ($collector.status.readyReplicas // 0),
    pendingOrTerminatingPods: ([
      $pods.items[]
      | select(.status.phase == "Pending" or .metadata.deletionTimestamp != null)
    ] | length),
    activeKubernetesJobs: ([
      $jobs.items[] | select((.status.active // 0) > 0)
    ] | length)
  }
' >"$WORKLOADS"

kubectl get hpa fastapi -n "$NAMESPACE" -o json |
  jq '{
    current: (.status.currentReplicas // 0),
    desired: (.status.desiredReplicas // 0)
  }' >"$HPA"

[[ "$(kubectl auth can-i delete pods -n "$NAMESPACE")" == "yes" ]] || \
  fail "existing operator identity cannot delete an isolated Spark driver Pod"
kubectl get serviceaccount asklake-msk-smoke -n "$NAMESPACE" >/dev/null
associations="$(aws eks list-pod-identity-associations \
  --region "$REGION" \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --namespace "$NAMESPACE" \
  --service-account asklake-msk-smoke \
  --output json)"
jq -e '.associations | length == 1' <<<"$associations" >/dev/null || \
  fail "MSK deny service account must have exactly one Pod Identity association"
association_id="$(jq -er '.associations[0].associationId' <<<"$associations")"
role_arn="$(aws eks describe-pod-identity-association \
  --region "$REGION" \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --association-id "$association_id" \
  --query 'association.roleArn' \
  --output text)"
role_name="${role_arn##*/}"
[[ -n "$role_name" && "$role_name" != "$role_arn" ]] || fail "MSK deny role is unavailable"
inline_policies="$(aws iam list-role-policies --role-name "$role_name" --output json)"
attached_policies="$(aws iam list-attached-role-policies --role-name "$role_name" --output json)"
jq -e '.PolicyNames | length == 0' <<<"$inline_policies" >/dev/null || \
  fail "MSK deny role must not have inline policies"
jq -e '.AttachedPolicies | length == 1' <<<"$attached_policies" >/dev/null || \
  fail "MSK deny role must have exactly one managed policy"
policy_arn="$(jq -er '.AttachedPolicies[0].PolicyArn' <<<"$attached_policies")"
policy_version="$(aws iam get-policy \
  --policy-arn "$policy_arn" \
  --query 'Policy.DefaultVersionId' \
  --output text)"
policy_document="$(aws iam get-policy-version \
  --policy-arn "$policy_arn" \
  --version-id "$policy_version" \
  --query 'PolicyVersion.Document' \
  --output json)"
jq -e '
  def array: if type == "array" then . else [.] end;
  ([.Statement[] | select(.Effect == "Allow") | .Action | array[]] | sort)
    == (["kafka-cluster:Connect", "kafka-cluster:DescribeTopic"] | sort)
  and ([.Statement[] | select(has("NotAction"))] | length) == 0
  and ([.Statement[]
    | select(.Effect == "Allow")
    | .Resource | array[]
    | select(test("\\*"))
  ] | length) == 0
  and ([.Statement[]
    | select(.Effect == "Allow")
    | select((.Action | array | index("kafka-cluster:Connect")) != null)
    | .Resource | array[]
    | select(test("^arn:aws:kafka:[^:]+:[0-9]{12}:cluster/[^/]+/[^/]+$"))
  ] | length) == 1
  and ([.Statement[]
    | select(.Effect == "Allow")
    | select((.Action | array | index("kafka-cluster:DescribeTopic")) != null)
    | .Resource | array[]
    | select(test("^arn:aws:kafka:[^:]+:[0-9]{12}:topic/[^/]+/[^/]+/asklake[.]eks-mvp[.]fixture[.]v1$"))
  ] | length) == 1
' <<<"$policy_document" >/dev/null || fail "MSK deny role is not exact Describe-only"

kubectl exec -i deployment/fastapi -n "$NAMESPACE" -c fastapi \
  -- python - <"$COLLECTOR" >"$REMOTE"
jq -e '
  .status == "passed"
  and .preflight.status == "passed"
  and .preflight.activeFixtureRuns == 0
  and .preflight.airflowConfigured == true
  and .preflight.sparkApplicationsReadable == true
  and .preflight.candidateChecksPassed == true
  and .activeSparkApplications == 0
  and .continuousActive == 0
  and (.targets.bounded | length) == 3
  and (.targets.faults | length) == 2
' "$REMOTE" >/dev/null || fail "in-cluster Day 18 preflight is blocked"

jq -e '
  .fastApiReady == 2
  and .collectorReady == 1
  and .pendingOrTerminatingPods == 0
  and .activeKubernetesJobs == 0
' "$WORKLOADS" >/dev/null || fail "Kubernetes workload baseline is not steady"
jq -e '.current == 2 and .desired == 2' "$HPA" >/dev/null || fail "FastAPI HPA is not at 2/2"

ec2_env_sha="$(asklake_sha256 <"$EC2_ENV")"
jq -n \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg clusterName "$ASKLAKE_EKS_CLUSTER_NAME" \
  --arg namespace "$NAMESPACE" \
  --arg region "$REGION" \
  --arg instanceId "$ASKLAKE_EC2_INSTANCE_ID" \
  --arg ec2EnvSha256 "$ec2_env_sha" \
  --argjson remote "$(cat "$REMOTE")" \
  --argjson workloads "$(cat "$WORKLOADS")" \
  --argjson hpa "$(cat "$HPA")" '
  {
    contractVersion:"1.0",
    campaign:"eks-day18-resilience",
    environment:"dev",
    createdAt:$createdAt,
    cluster:{name:$clusterName,namespace:$namespace,region:$region},
    preservedEc2:{instanceId:$instanceId,envFileSha256:$ec2EnvSha256},
    visibility:{
      mode:"in-cluster-backend-service-account",
      sparkApplicationsReadable:$remote.preflight.sparkApplicationsReadable
    },
    baseline:{
      activeFixtureRuns:$remote.preflight.activeFixtureRuns,
      activeSparkApplications:$remote.activeSparkApplications,
      activeKubernetesJobs:$workloads.activeKubernetesJobs,
      pendingOrTerminatingPods:$workloads.pendingOrTerminatingPods,
      fastApiReady:$workloads.fastApiReady,
      collectorReady:$workloads.collectorReady,
      hpaCurrent:$hpa.current,
      hpaDesired:$hpa.desired,
      continuousActive:$remote.continuousActive
    },
    checks:{
      fastApiImageMatchesReceipt:true,
      collectorImageMatchesReceipt:true,
      externalHealthSteady:true,
      airflowConfigured:$remote.preflight.airflowConfigured,
      mskDenyServiceAccountPresent:true,
      driverDeleteAllowed:true,
      continuousBoundaryVerified:true
    },
    targets:$remote.targets
  }
' >"$LIVE_INPUT"

chmod 0600 "$LIVE_INPUT"
node "$ROOT_DIR/scripts/verify-eks-day18-live-input.mjs" "$LIVE_INPUT" >/dev/null
mv "$LIVE_INPUT" "$OUTPUT"
chmod 0600 "$OUTPUT"

echo "day18_live_input=prepared"
echo "day18_live_input_mode=0600"
echo "day18_live_input_targets=bounded-3_fault-2"
echo "day18_live_input_cluster_mutation=zero"
