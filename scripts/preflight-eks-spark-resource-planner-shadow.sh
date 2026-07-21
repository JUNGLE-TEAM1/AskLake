#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
BASE_VALUES="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
BASE_WEB_VALUES="${ASKLAKE_WEB_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.web.private-values.json}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
WEB_CHART="$ROOT_DIR/infra/eks/helm/asklake-web"
RELEASE="asklake-runtime-config"
TARGET_MODE="${ASKLAKE_SPARK_RESOURCE_PLANNER_TARGET_MODE:-shadow}"
case "$TARGET_MODE" in
  off)
    DEFAULT_CANDIDATE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-off.runtime-config-values.json"
    DEFAULT_CANDIDATE_WEB_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-off.web.private-values.json"
    BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-values.mjs"
    WEB_BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-off-web-values.mjs"
    ;;
  shadow)
    DEFAULT_CANDIDATE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-shadow.runtime-config-values.json"
    DEFAULT_CANDIDATE_WEB_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-shadow.web.private-values.json"
    BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-values.mjs"
    WEB_BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-web-values.mjs"
    ;;
  enforce)
    DEFAULT_CANDIDATE_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-enforce.runtime-config-values.json"
    DEFAULT_CANDIDATE_WEB_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-enforce.web.private-values.json"
    BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-values.mjs"
    WEB_BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-web-values.mjs"
    ;;
  *)
    echo "ASKLAKE_SPARK_RESOURCE_PLANNER_TARGET_MODE must be off, shadow, or enforce" >&2
    exit 1
    ;;
esac
CANDIDATE_VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$DEFAULT_CANDIDATE_VALUES}"
CANDIDATE_WEB_VALUES="${ASKLAKE_WEB_VALUES:-$DEFAULT_CANDIDATE_WEB_VALUES}"
TEMP_DIR="$(mktemp -d)"

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

for command in git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || \
  fail "current image receipt is invalid"
[[ "$(jq -er '.gitRevision' "$RECEIPT")" == "$(git -C "$ROOT_DIR" rev-parse HEAD)" ]] || \
  fail "formal image receipt must match the checked-out merge revision"
for values in "$BASE_VALUES" "$CANDIDATE_VALUES" "$BASE_WEB_VALUES" "$CANDIDATE_WEB_VALUES"; do
  [[ -s "$values" ]] || fail "private runtime ConfigMap values are missing"
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || \
    fail "private runtime ConfigMap values must remain ignored"
  [[ "$(stat -f '%Lp' "$values")" == "600" ]] || \
    fail "private runtime ConfigMap values must use mode 0600"
done

if [[ "$TARGET_MODE" == "off" ]]; then
  node "$BUILDER" "$BASE_VALUES" "$RECEIPT" >"$TEMP_DIR/expected-candidate.json"
else
  node "$BUILDER" "$BASE_VALUES" >"$TEMP_DIR/expected-candidate.json"
fi
jq -S -c . "$TEMP_DIR/expected-candidate.json" >"$TEMP_DIR/expected-canonical.json"
jq -S -c . "$CANDIDATE_VALUES" >"$TEMP_DIR/candidate-canonical.json"
cmp -s "$TEMP_DIR/expected-canonical.json" "$TEMP_DIR/candidate-canonical.json" || \
  fail "candidate values are not the exact Phase 3 $TARGET_MODE delta"
node "$WEB_BUILDER" "$BASE_WEB_VALUES" "$CANDIDATE_VALUES" \
  >"$TEMP_DIR/expected-web-candidate.json"
jq -S -c . "$TEMP_DIR/expected-web-candidate.json" >"$TEMP_DIR/expected-web-canonical.json"
jq -S -c . "$CANDIDATE_WEB_VALUES" >"$TEMP_DIR/candidate-web-canonical.json"
cmp -s "$TEMP_DIR/expected-web-canonical.json" "$TEMP_DIR/candidate-web-canonical.json" || \
  fail "Web candidate does not contain the exact runtimeConfigRevision delta"

verify_asklake_eks_context
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json >"$TEMP_DIR/live-config.json"
jq -e --arg release "$RELEASE" --arg namespace "$NAMESPACE" '
  .metadata.labels["app.kubernetes.io/managed-by"] == "Helm"
  and .metadata.annotations["meta.helm.sh/release-name"] == $release
  and .metadata.annotations["meta.helm.sh/release-namespace"] == $namespace
' "$TEMP_DIR/live-config.json" >/dev/null || \
  fail "runtime ConfigMap is not owned by the dedicated Helm release"
jq -S -c '.data' "$TEMP_DIR/live-config.json" >"$TEMP_DIR/live-data.json"
jq -S -c '.configMap.data' "$BASE_VALUES" >"$TEMP_DIR/base-data.json"
cmp -s "$TEMP_DIR/live-data.json" "$TEMP_DIR/base-data.json" || \
  fail "live runtime ConfigMap drifted from the captured base values"
helm get values asklake-web -n "$NAMESPACE" -o json \
  | jq -S -c . >"$TEMP_DIR/live-web-values.json"
jq -S -c . "$BASE_WEB_VALUES" >"$TEMP_DIR/base-web-canonical.json"
cmp -s "$TEMP_DIR/live-web-values.json" "$TEMP_DIR/base-web-canonical.json" || \
  fail "live asklake-web values drifted from the captured base values"

expected_backend_image="$(jq -er '.images.backend' "$RECEIPT")"
expected_spark_image="$(jq -er '.images.sparkRuntime' "$RECEIPT")"
kubectl get deployment fastapi -n "$NAMESPACE" -o json >"$TEMP_DIR/fastapi.json"
kubectl get deployment trino-result-collector -n "$NAMESPACE" -o json >"$TEMP_DIR/collector.json"
jq -e --arg image "$expected_backend_image" '
  (.status.readyReplicas // 0) == 2
  and (.status.availableReplicas // 0) == 2
  and ([.spec.template.spec.containers[] | select(.name == "fastapi") | .image] == [$image])
' "$TEMP_DIR/fastapi.json" >/dev/null || \
  fail "FastAPI is not Ready on the candidate Backend image"
jq -e --arg image "$expected_backend_image" '
  (.status.readyReplicas // 0) == 1
  and (.status.availableReplicas // 0) == 1
  and ([.spec.template.spec.containers[] | select(.name == "trino-result-collector") | .image] == [$image])
' "$TEMP_DIR/collector.json" >/dev/null || \
  fail "Collector is not Ready on the candidate Backend image"
jq -e --arg image "$expected_spark_image" --arg mode "$TARGET_MODE" '
  .configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE == $image
  and .configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE == $mode
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES == "1"
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES == "2"
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST == "2"
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT == "3"
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY == "4g"
  and .configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD == "1g"
' "$CANDIDATE_VALUES" >/dev/null || \
  fail "candidate image, mode, baseline, or standard-v1 profile is invalid"

helm lint "$CHART" -f "$CANDIDATE_VALUES" >/dev/null
helm template "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_VALUES" >"$TEMP_DIR/rendered.yaml"
kubectl create --dry-run=client -f "$TEMP_DIR/rendered.yaml" -o json \
  | jq -S -c '.data' >"$TEMP_DIR/rendered-data.json"
jq -S -c '.configMap.data' "$CANDIDATE_VALUES" >"$TEMP_DIR/candidate-data.json"
cmp -s "$TEMP_DIR/rendered-data.json" "$TEMP_DIR/candidate-data.json" || \
  fail "rendered runtime ConfigMap differs from the candidate values"
helm lint "$WEB_CHART" -f "$CANDIDATE_WEB_VALUES" >/dev/null
helm template asklake-web "$WEB_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_WEB_VALUES" >"$TEMP_DIR/rendered-web.yaml"
runtime_revision="$(jq -r '.backend.runtimeConfigRevision' "$CANDIDATE_WEB_VALUES")"
[[ "$(grep -c "asklake.io/runtime-config-revision: \"$runtime_revision\"" \
  "$TEMP_DIR/rendered-web.yaml")" == "2" ]] || \
  fail "Web candidate does not restart FastAPI and Collector on the same runtime revision"

release_before="$(helm list -n "$NAMESPACE" -o json \
  | jq -r '.[] | select(.name == "'"$RELEASE"'") | .revision')"
web_release_before="$(helm list -n "$NAMESPACE" -o json \
  | jq -r '.[] | select(.name == "asklake-web") | .revision')"
resource_version_before="$(jq -r '.metadata.resourceVersion' "$TEMP_DIR/live-config.json")"
fastapi_generation_before="$(jq -r '.metadata.generation' "$TEMP_DIR/fastapi.json")"
collector_generation_before="$(jq -r '.metadata.generation' "$TEMP_DIR/collector.json")"
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_VALUES" --dry-run=server >/dev/null
helm upgrade --install asklake-web "$WEB_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_WEB_VALUES" --dry-run=server >/dev/null
[[ "$(helm list -n "$NAMESPACE" -o json \
  | jq -r '.[] | select(.name == "'"$RELEASE"'") | .revision')" == "$release_before" ]] || \
  fail "server dry-run changed the runtime ConfigMap release"
[[ "$(helm list -n "$NAMESPACE" -o json \
  | jq -r '.[] | select(.name == "asklake-web") | .revision')" == "$web_release_before" ]] || \
  fail "server dry-run changed the asklake-web release"
[[ "$(kubectl get configmap asklake-runtime -n "$NAMESPACE" \
  -o jsonpath='{.metadata.resourceVersion}')" == "$resource_version_before" ]] || \
  fail "server dry-run changed the runtime ConfigMap"
[[ "$(kubectl get deployment fastapi -n "$NAMESPACE" \
  -o jsonpath='{.metadata.generation}')" == "$fastapi_generation_before" ]] || \
  fail "server dry-run changed FastAPI"
[[ "$(kubectl get deployment trino-result-collector -n "$NAMESPACE" \
  -o jsonpath='{.metadata.generation}')" == "$collector_generation_before" ]] || \
  fail "server dry-run changed Collector"

active_spark="$(kubectl get sparkapplications -n "$NAMESPACE" -o json | jq '
  [.items[]
    | (.status.applicationState.state // "UNKNOWN" | ascii_upcase) as $state
    | select($state != "COMPLETED" and $state != "FAILED")
  ]
  | length
')"
[[ "$active_spark" == "0" ]] || \
  fail "active SparkApplications must be zero at the $TARGET_MODE apply checkpoint"

echo "spark_resource_planner_${TARGET_MODE}_preflight=passed"
echo "spark_resource_planner_${TARGET_MODE}_preflight_cluster_mutation=zero"
echo "spark_resource_planner_${TARGET_MODE}_preflight_active_spark=0"
