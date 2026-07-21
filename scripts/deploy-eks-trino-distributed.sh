#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
VALUES="${2:-}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
CONTEXT="${ASKLAKE_EKS_CONTEXT:-asklake-dev}"
CLUSTER="${ASKLAKE_EKS_CLUSTER_NAME:-asklake-dev}"
RELEASE="asklake-trino"
LOCK_NAME="asklake-trino-deploy-lock"
CHART="$ROOT_DIR/infra/eks/helm/asklake-workloads"
BASE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$MODE" == "--render" || "$MODE" == "--apply" ]] || \
  fail "usage: deploy-eks-trino-distributed.sh --render|--apply <ignored-private-values.json>"
[[ -n "$VALUES" && -s "$VALUES" ]] || fail "private Trino values are required"
for command in aws git helm jq kubectl python3 rg; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "$(kubectl config current-context)" == "$CONTEXT" ]] || fail "unexpected Kubernetes context"

kube_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
aws_endpoint="$(aws eks describe-cluster --name "$CLUSTER" --query 'cluster.endpoint' --output text)"
[[ -n "$kube_endpoint" && "$kube_endpoint" == "$aws_endpoint" ]] || fail "Kubernetes context does not match the EKS cluster"

git -C "$ROOT_DIR" check-ignore -q -- "$VALUES" || fail "private Trino values must be ignored by Git"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$VALUES" >/dev/null 2>&1; then
  fail "private Trino values must not be tracked"
fi
[[ "$(stat -f '%Lp' "$VALUES")" == "600" ]] || fail "private Trino values must use mode 0600"

expected_workers="$(jq -er '
  select(.namespace == "asklake-dev") |
  select(.trino.enabled == true) |
  select(.trino.distributed.enabled == true) |
  select(.trino.distributed.includeCoordinator == false) |
  .trino.distributed.workerReplicas |
  select(type == "number" and floor == . and . == 2)
' "$VALUES")" || fail "distributed Trino private values must declare the fixed two-worker policy"

if jq -e '.. | objects | has("password") or has("token") or has("secretValue") or has("data") or has("stringData")' "$VALUES" >/dev/null; then
  fail "private Trino values contain a Secret-shaped property"
fi
if rg -q 'AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|BEGIN .*PRIVATE KEY' "$VALUES"; then
  fail "private Trino values contain a forbidden credential"
fi

[[ "$(helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -r '.info.status')" == "deployed" ]] || \
  fail "the existing asklake-trino release must be deployed"
observed_revision="$(helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -er '.version')"

for resource in deployment/asklake-trino service/asklake-trino configmap/asklake-trino-config; do
  [[ "$(kubectl get "$resource" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}')" == "$RELEASE" ]] || \
    fail "$resource is not owned by the asklake-trino release"
done
kubectl get serviceaccount asklake-trino -n "$NAMESPACE" >/dev/null
kubectl get secret asklake-trino-runtime -n "$NAMESPACE" >/dev/null
[[ "$(kubectl get externalsecret asklake-trino-runtime -n "$NAMESPACE" -o json | jq -r '
  any(.status.conditions[]?; .type == "Ready" and .status == "True")
')" == "true" ]] || fail "asklake-trino-runtime ExternalSecret is not Ready"

association_count="$(aws eks list-pod-identity-associations \
  --cluster-name "$CLUSTER" --namespace "$NAMESPACE" --service-account asklake-trino \
  --query 'length(associations)' --output text)"
[[ "$association_count" == "1" ]] || fail "asklake-trino must have exactly one Pod Identity association"

component_overrides=(
  --set frontend.enabled=false
  --set backend.enabled=false
  --set airflow.enabled=false
)
rendered="$(mktemp)"
live_values="$(mktemp)"
single_values="$(mktemp)"
single_rendered="$(mktemp)"
live_without_distributed="$(mktemp)"
candidate_without_distributed="$(mktemp)"
lock_uid=""
cleanup() {
  rm -f "$rendered" "$live_values" "$single_values" "$single_rendered" "$live_without_distributed" "$candidate_without_distributed"
  if [[ -n "$lock_uid" ]]; then
    if ! python3 "$ROOT_DIR/scripts/lib/delete_kubernetes_resource_with_uid.py" \
      --resource-path "/api/v1/namespaces/$NAMESPACE/configmaps/$LOCK_NAME" \
      --uid "$lock_uid" >/dev/null 2>&1; then
      echo "warning: failed to release the Trino deployment lock with its UID precondition" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

helm get values "$RELEASE" -n "$NAMESPACE" --revision "$observed_revision" -o json >"$live_values"
observed_distributed="$(jq -r '.trino.distributed.enabled // false' "$live_values")"
if [[ "$observed_distributed" == "true" ]]; then
  observed_workers="$(jq -er '.trino.distributed.workerReplicas | select(type == "number" and floor == . and . >= 1 and . <= 5)' "$live_values")" || \
    fail "the observed distributed revision has an invalid worker count"
else
  observed_workers=0
fi
jq -eS '.trino.distributed = {enabled:false}' "$live_values" >"$single_values"
jq -S 'del(.trino.distributed)' "$live_values" >"$live_without_distributed"
jq -S 'del(.trino.distributed)' "$VALUES" >"$candidate_without_distributed"
cmp -s "$live_without_distributed" "$candidate_without_distributed" || \
  fail "candidate values change more than the Trino distributed overlay"

"$ROOT_DIR/scripts/verify-eks-trino-distributed.sh" >/dev/null
helm lint "$CHART" -f "$BASE_VALUES" -f "$VALUES" "${component_overrides[@]}" >/dev/null
helm lint "$CHART" -f "$BASE_VALUES" -f "$single_values" "${component_overrides[@]}" >/dev/null
helm template "$RELEASE" "$CHART" -f "$BASE_VALUES" -f "$VALUES" \
  "${component_overrides[@]}" >"$rendered"
helm template "$RELEASE" "$CHART" -f "$BASE_VALUES" -f "$single_values" \
  "${component_overrides[@]}" >"$single_rendered"
grep -q '^  name: asklake-trino-discovery$' "$rendered" || fail "headless discovery Service is missing"
grep -q '^    type: Recreate$' "$rendered" || fail "single-coordinator rollout strategy is missing"
grep -q "^  replicas: $expected_workers$" "$rendered" || fail "worker replica render does not match private values"
if grep -q '^  name: asklake-trino-worker$\|^  name: asklake-trino-discovery$' "$single_rendered"; then
  fail "safe single-coordinator candidate contains distributed resources"
fi
grep -q 'discovery.uri=https://127.0.0.1:8443' "$single_rendered" || \
  fail "safe single-coordinator candidate does not restore localhost discovery"

current_image="$(kubectl get deployment asklake-trino -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
candidate_image="$(grep '^          image: ".*/trino@sha256:' "$rendered" | head -n 1 | sed -E 's/^ *image: "(.*)"$/\1/')"
[[ -n "$current_image" && "$candidate_image" == "$current_image" ]] || \
  fail "distributed rollout must preserve the current immutable Trino image"

helm upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$BASE_VALUES" -f "$single_values" "${component_overrides[@]}" \
  --reset-values --dry-run=server --hide-secret >/dev/null
helm upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$BASE_VALUES" -f "$VALUES" "${component_overrides[@]}" \
  --reset-values --dry-run=server --hide-secret >/dev/null
[[ "$(helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -er '.version')" == "$observed_revision" ]] || \
  fail "asklake-trino changed during preflight"

if [[ "$MODE" == "--render" ]]; then
  jq -cn --argjson workers "$expected_workers" '{contract:"eks-trino-distributed-preflight-v1",expectedWorkers:$workers,imagePreserved:true,serverDryRun:true,status:"passed"}'
  exit 0
fi
[[ "${ASKLAKE_TRINO_DISTRIBUTED_APPLY_CONFIRM:-}" == "apply-distributed-trino" ]] || \
  fail "set ASKLAKE_TRINO_DISTRIBUTED_APPLY_CONFIRM=apply-distributed-trino"
deployment_commit="${ASKLAKE_TRINO_DEPLOYMENT_COMMIT:-}"
[[ "$deployment_commit" =~ ^[0-9a-f]{40}$ ]] || \
  fail "set ASKLAKE_TRINO_DEPLOYMENT_COMMIT to the deployed dev full SHA"
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$deployment_commit" ]] || \
  fail "the deployment worktree is not at ASKLAKE_TRINO_DEPLOYMENT_COMMIT"
[[ "$(git -C "$ROOT_DIR" rev-parse origin/dev)" == "$deployment_commit" ]] || \
  fail "ASKLAKE_TRINO_DEPLOYMENT_COMMIT is not the fetched origin/dev tip"
git -C "$ROOT_DIR" diff --quiet || fail "the deployment worktree has unstaged tracked changes"
git -C "$ROOT_DIR" diff --cached --quiet || fail "the deployment worktree has staged changes"

lock_object=""
lock_acquired_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if ! lock_object="$(kubectl create configmap "$LOCK_NAME" -n "$NAMESPACE" \
  --from-literal="deploymentCommit=$deployment_commit" \
  --from-literal="observedRevision=$observed_revision" \
  --from-literal="acquiredAt=$lock_acquired_at" -o json 2>/dev/null)"; then
  fail "another Trino deployment campaign holds the Kubernetes release lock"
fi
lock_uid="$(jq -er '.metadata.uid' <<<"$lock_object")" || fail "the Trino deployment lock has no UID"

verify_campaign_lock() {
  [[ "$(kubectl get configmap "$LOCK_NAME" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}' 2>/dev/null)" == "$lock_uid" ]] || \
    fail "the Trino deployment campaign lost its Kubernetes release lock"
}

current_revision() {
  helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -er '.version'
}

assert_campaign_revision() {
  local expected_revision="$1"
  local message="$2"
  verify_campaign_lock
  [[ "$(current_revision)" == "$expected_revision" ]] || \
    fail "$message; refusing to mutate or accept a foreign Helm revision"
}

verify_campaign_lock
[[ "$(current_revision)" == "$observed_revision" ]] || \
  fail "asklake-trino changed after preflight and before the campaign lock was acquired"

verify_single_mode() {
  local backend_pod single_query_ready
  kubectl rollout status deployment/asklake-trino -n "$NAMESPACE" --timeout=10m >/dev/null || return 1
  [[ "$(kubectl get deployment asklake-trino -n "$NAMESPACE" -o jsonpath='{.spec.strategy.type}')" == "Recreate" ]] || \
    { echo "single coordinator baseline is not using Recreate" >&2; return 1; }
  [[ "$(kubectl get deployment asklake-trino -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')" == "1" ]] || \
    { echo "single coordinator baseline is not Ready" >&2; return 1; }
  if kubectl get deployment asklake-trino-worker -n "$NAMESPACE" >/dev/null 2>&1 || \
     kubectl get service asklake-trino-discovery -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "single coordinator baseline contains distributed resources" >&2
    return 1
  fi
  grep -q 'discovery.uri=https://127.0.0.1:8443' < <(kubectl get configmap asklake-trino-config -n "$NAMESPACE" -o jsonpath='{.data.config\.properties}') || \
    { echo "single coordinator baseline did not restore localhost discovery" >&2; return 1; }
  backend_pod="$(kubectl get pod -n "$NAMESPACE" -l 'app.kubernetes.io/component=backend' -o json | jq -r '
    [.items[] | select(.status.phase == "Running") |
      select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
      .metadata.name] | sort | first // empty
  ')"
  [[ -n "$backend_pod" ]] || { echo "a Ready FastAPI Pod is required for the Trino query gate" >&2; return 1; }
  single_query_ready=false
  for _ in {1..18}; do
    if kubectl exec -i -n "$NAMESPACE" "$backend_pod" -- \
      python - 0 <"$ROOT_DIR/scripts/lib/verify_eks_trino_active_workers.py" >/dev/null 2>&1; then
      single_query_ready=true
      break
    fi
    sleep 5
  done
  [[ "$single_query_ready" == "true" ]] || {
    echo "single coordinator Iceberg query did not recover before the 90-second deadline" >&2
    return 1
  }
}

verify_observed_mode() {
  local backend_pod observed_query_ready
  if [[ "$observed_distributed" != "true" ]]; then
    verify_single_mode
    return
  fi
  kubectl rollout status deployment/asklake-trino -n "$NAMESPACE" --timeout=10m >/dev/null || return 1
  kubectl rollout status deployment/asklake-trino-worker -n "$NAMESPACE" --timeout=10m >/dev/null || return 1
  [[ "$(kubectl get deployment asklake-trino-worker -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')" == "$observed_workers" ]] || return 1
  [[ "$(kubectl get deployment asklake-trino-worker -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')" == "$observed_workers" ]] || return 1
  backend_pod="$(kubectl get pod -n "$NAMESPACE" -l 'app.kubernetes.io/component=backend' -o json | jq -r '
    [.items[] | select(.status.phase == "Running") |
      select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
      .metadata.name] | sort | first // empty
  ')"
  [[ -n "$backend_pod" ]] || return 1
  observed_query_ready=false
  for _ in {1..18}; do
    if kubectl exec -i -n "$NAMESPACE" "$backend_pod" -- \
      python - "$observed_workers" <"$ROOT_DIR/scripts/lib/verify_eks_trino_active_workers.py" >/dev/null 2>&1; then
      observed_query_ready=true
      break
    fi
    sleep 5
  done
  [[ "$observed_query_ready" == "true" ]]
}

restore_observed_revision() {
  local reason="$1"
  local expected_current_revision="$2"
  local restored_revision
  assert_campaign_revision "$expected_current_revision" "$reason"
  echo "$reason; restoring observed revision $observed_revision" >&2
  if ! helm rollback "$RELEASE" "$observed_revision" -n "$NAMESPACE" \
    --cleanup-on-fail --wait=watcher --timeout=15m; then
    fail "$reason and restoring the observed revision failed; manual recovery is required"
  fi
  restored_revision="$(current_revision)"
  verify_observed_mode || fail "$reason and the restored observed revision did not pass its query gate; manual recovery is required"
  assert_campaign_revision "$restored_revision" "$reason and observed-revision recovery"
  fail "$reason; the observed revision was restored"
}

# Always create a fresh safe rollback target from the observed live values with
# distributed mode removed. This is required both for first enablement and for
# an already-distributed release changing its fixed worker policy.
verify_campaign_lock
[[ "$(current_revision)" == "$observed_revision" ]] || fail "asklake-trino changed before the single baseline upgrade"
baseline_revision=""
if ! baseline_revision="$(helm upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$BASE_VALUES" -f "$single_values" "${component_overrides[@]}" \
  --reset-values --rollback-on-failure --cleanup-on-fail --wait=watcher --timeout=15m \
  -o json | jq -er '.version')"; then
  failed_baseline_revision="$(current_revision)"
  if verify_observed_mode; then
    assert_campaign_revision "$failed_baseline_revision" "failed single-baseline upgrade recovery"
    fail "failed to create the safe single-coordinator Recreate baseline; the observed mode remains healthy"
  fi
  restore_observed_revision "failed to create the safe single-coordinator Recreate baseline" "$failed_baseline_revision"
fi
assert_campaign_revision "$baseline_revision" "single baseline Helm response"
if ! verify_single_mode; then
  restore_observed_revision "safe single-coordinator baseline verification failed" "$baseline_revision"
fi
assert_campaign_revision "$baseline_revision" "single baseline verification"

verify_campaign_lock
[[ "$(current_revision)" == "$baseline_revision" ]] || fail "asklake-trino changed before the fixed two-worker upgrade"
candidate_revision=""
if ! candidate_revision="$(helm upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$BASE_VALUES" -f "$VALUES" "${component_overrides[@]}" \
  --reset-values --rollback-on-failure --cleanup-on-fail --wait=watcher --timeout=15m \
  -o json | jq -er '.version')"; then
  failed_candidate_revision="$(current_revision)"
  verify_single_mode || fail "distributed Trino upgrade failed and the safe single baseline could not be verified; manual recovery is required"
  assert_campaign_revision "$failed_candidate_revision" "failed fixed two-worker upgrade recovery"
  fail "distributed Trino Helm upgrade failed; the safe single-coordinator baseline was restored"
fi
assert_campaign_revision "$candidate_revision" "fixed two-worker Helm response"

if ! "$ROOT_DIR/scripts/verify-eks-trino-distributed-live.sh" "$expected_workers"; then
  echo "distributed Trino live gate failed; rolling back revision $baseline_revision" >&2
  verify_campaign_lock
  [[ "$(current_revision)" == "$candidate_revision" ]] || \
    fail "asklake-trino changed during the live gate; refusing to roll back a foreign revision"
  if ! helm rollback "$RELEASE" "$baseline_revision" -n "$NAMESPACE" \
    --cleanup-on-fail --wait=watcher --timeout=15m; then
    fail "distributed Trino live gate and automatic rollback both failed; manual recovery is required"
  fi
  rollback_revision="$(current_revision)"
  verify_single_mode || fail "distributed Trino live gate failed and the safe single rollback could not be verified; manual recovery is required"
  assert_campaign_revision "$rollback_revision" "safe single rollback verification"
  fail "distributed Trino rollout was rolled back"
fi
assert_campaign_revision "$candidate_revision" "fixed two-worker live verification"

echo "EKS distributed Trino rollout passed revision, active-worker, and non-empty Iceberg query gates."
