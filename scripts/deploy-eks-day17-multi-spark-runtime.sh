#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
BASE_VALUES="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
CANDIDATE_VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.day17-multi-spark.runtime-config-values.json}"
IAM_RECEIPT="${ASKLAKE_DAY17_IAM_RECEIPT:-}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
RELEASE="asklake-runtime-config"
TEMP_DIR="$(mktemp -d)"
LIVE="$TEMP_DIR/live.json"
RENDERED="$TEMP_DIR/rendered.yaml"

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--apply" ]] || \
  fail "usage: deploy-eks-day17-multi-spark-runtime.sh [--preflight|--apply]"
for command in git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || \
  fail "current image receipt is invalid"
for values in "$BASE_VALUES" "$CANDIDATE_VALUES"; do
  [[ -s "$values" ]] || fail "private runtime ConfigMap values are missing"
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || \
    fail "private runtime ConfigMap values must remain ignored"
  [[ "$(stat -f '%Lp' "$values")" == "600" ]] || \
    fail "private runtime ConfigMap values must use mode 0600"
done

verify_asklake_eks_context
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json >"$LIVE"
jq -e --arg release "$RELEASE" --arg namespace "$NAMESPACE" '
  .metadata.labels["app.kubernetes.io/managed-by"] == "Helm"
  and .metadata.annotations["meta.helm.sh/release-name"] == $release
  and .metadata.annotations["meta.helm.sh/release-namespace"] == $namespace
' "$LIVE" >/dev/null || \
  fail "runtime ConfigMap is not owned by the dedicated Helm release"

jq -e --slurp '
  .[0] as $base
  | .[1] as $candidate
  | $base.namespace == "asklake-dev"
  and $candidate.namespace == "asklake-dev"
  and $base.configMap.name == "asklake-runtime"
  and $candidate.configMap.name == "asklake-runtime"
  and (
    [
      (
        ($base.configMap.data | keys)
        + ($candidate.configMap.data | keys)
      )
      | unique[]
      | select(
          $base.configMap.data[.] != $candidate.configMap.data[.]
        )
    ]
    | sort
  ) == [
    "ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON",
    "ASKLAKE_SPARK_KUBERNETES_IMAGE"
  ]
' "$BASE_VALUES" "$CANDIDATE_VALUES" >/dev/null || \
  fail "Day 17 runtime candidate changed more than the approved two keys"

jq -e '
  .configMap.data.ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON
  | fromjson
  | . == [
      {
        consumerGroup: "asklake-eks-mvp-spark-v1",
        table: "eks_mvp_fixture"
      },
      {
        consumerGroup: "asklake-eks-mvp-spark-scale17-01",
        table: "eks_mvp_scale_17_01"
      },
      {
        consumerGroup: "asklake-eks-mvp-spark-scale17-02",
        table: "eks_mvp_scale_17_02"
      },
      {
        consumerGroup: "asklake-eks-mvp-spark-scale17-03",
        table: "eks_mvp_scale_17_03"
      }
    ]
' "$CANDIDATE_VALUES" >/dev/null || \
  fail "Day 17 runtime candidate does not contain the exact four-slot contract"

expected_spark_image="$(jq -r '.images.sparkRuntime' "$RECEIPT")"
candidate_spark_image="$(jq -r '.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE' "$CANDIDATE_VALUES")"
[[ -n "$expected_spark_image" && "$candidate_spark_image" == "$expected_spark_image" ]] || \
  fail "Day 17 runtime candidate Spark image differs from the formal receipt"

jq -S -c '.data' "$LIVE" >"$TEMP_DIR/live-data.json"
jq -S -c '.configMap.data' "$BASE_VALUES" >"$TEMP_DIR/base-data.json"
cmp -s "$TEMP_DIR/live-data.json" "$TEMP_DIR/base-data.json" || \
  fail "live runtime ConfigMap drifted from the captured base values"

helm lint "$CHART" -f "$CANDIDATE_VALUES" >/dev/null
helm template "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$CANDIDATE_VALUES" >"$RENDERED"
kubectl create --dry-run=client -f "$RENDERED" -o json \
  | jq -S -c '.data' >"$TEMP_DIR/rendered-data.json"
jq -S -c '.configMap.data' "$CANDIDATE_VALUES" >"$TEMP_DIR/candidate-data.json"
cmp -s "$TEMP_DIR/rendered-data.json" "$TEMP_DIR/candidate-data.json" || \
  fail "rendered runtime ConfigMap differs from the candidate values"

release_before="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "'"$RELEASE"'") | .revision')"
resource_version_before="$(jq -r '.metadata.resourceVersion' "$LIVE")"
fastapi_generation_before="$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.metadata.generation}')"
fastapi_pods_before="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"

helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_VALUES" --dry-run=server >/dev/null
[[ "$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "'"$RELEASE"'") | .revision')" == "$release_before" ]] || \
  fail "server dry-run changed the runtime ConfigMap release"
[[ "$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o jsonpath='{.metadata.resourceVersion}')" == "$resource_version_before" ]] || \
  fail "server dry-run changed the runtime ConfigMap"
[[ "$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.metadata.generation}')" == "$fastapi_generation_before" ]] || \
  fail "server dry-run changed the FastAPI Deployment"
[[ "$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)" == "$fastapi_pods_before" ]] || \
  fail "server dry-run replaced FastAPI Pods"

if [[ "$MODE" == "--preflight" ]]; then
  echo "day17_runtime_candidate=preflight_passed"
  echo "day17_runtime_candidate_delta=fixture_slots_and_spark_image_only"
  echo "day17_runtime_candidate_cluster_mutation=zero"
  exit 0
fi

[[ "${ASKLAKE_DAY17_RUNTIME_CONFIRM:-}" == "apply-exact-multi-spark-runtime" ]] || \
  fail "set ASKLAKE_DAY17_RUNTIME_CONFIRM=apply-exact-multi-spark-runtime"
[[ -n "$IAM_RECEIPT" && -s "$IAM_RECEIPT" ]] || \
  fail "ASKLAKE_DAY17_IAM_RECEIPT is required for apply"
git -C "$ROOT_DIR" check-ignore -q -- "$IAM_RECEIPT" || \
  fail "Day 17 IAM receipt must remain ignored"
[[ "$(stat -f '%Lp' "$IAM_RECEIPT")" == "600" ]] || \
  fail "Day 17 IAM receipt must use mode 0600"
jq -e '
  .contractVersion == "1.0"
  and .status == "passed"
  and .checks.planApplySuccess == true
  and .checks.exactGroupResources == 4
  and .checks.groupWildcardResources == 0
  and .checks.otherIamStatementsChanged == 0
  and .checks.nodePoolChanged == 0
  and .checks.rbacChanged == 0
' "$IAM_RECEIPT" >/dev/null || \
  fail "Day 17 IAM receipt does not satisfy the exact apply contract"

helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_VALUES" --rollback-on-failure --wait --timeout 5m >/dev/null
live_after="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json)"
jq -S -c '.data' <<<"$live_after" >"$TEMP_DIR/live-after-data.json"
cmp -s "$TEMP_DIR/live-after-data.json" "$TEMP_DIR/candidate-data.json" || \
  fail "runtime ConfigMap did not converge on the Day 17 candidate"
release_after="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "'"$RELEASE"'") | .revision')"
[[ "$release_after" =~ ^[0-9]+$ && "$release_after" -gt "$release_before" ]] || \
  fail "runtime ConfigMap release revision did not advance"
[[ "$(kubectl get deployment fastapi -n "$NAMESPACE" -o jsonpath='{.metadata.generation}')" == "$fastapi_generation_before" ]] || \
  fail "runtime ConfigMap apply unexpectedly changed the FastAPI Deployment"
[[ "$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)" == "$fastapi_pods_before" ]] || \
  fail "runtime ConfigMap apply unexpectedly replaced FastAPI Pods"

echo "day17_runtime_config=applied"
echo "day17_runtime_config_delta=fixture_slots_and_spark_image_only"
echo "day17_runtime_fastapi_restart=pending"
