#!/usr/bin/env bash

set -Eeuo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
BASE_RUNTIME="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.base.runtime-config-values.json}"
BASE_WEB="${ASKLAKE_WEB_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.base.private-values.json}"
CANDIDATE_RUNTIME="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.runtime-config-values.json}"
CANDIDATE_WEB="${ASKLAKE_WEB_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.web.private-values.json}"
RECEIPT="${ASKLAKE_IMAGE_RECEIPT:-}"
RUNTIME_CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
WEB_CHART="$ROOT_DIR/infra/eks/helm/asklake-web"
BUILDER="$ROOT_DIR/scripts/build-eks-spark-hybrid-activation-values.mjs"
RUNTIME_RELEASE="asklake-runtime-config"
WEB_RELEASE="asklake-web"
TEMP_DIR="$(mktemp -d)"
RUNTIME_APPLIED=false
WEB_APPLIED=false
RUNTIME_REVISION_BEFORE=""
WEB_REVISION_BEFORE=""
ALB_STEADY_TIMEOUT_SECONDS="${ASKLAKE_ALB_STEADY_TIMEOUT_SECONDS:-600}"
ALB_STEADY_POLL_SECONDS="${ASKLAKE_ALB_STEADY_POLL_SECONDS:-15}"
ALB_STEADY_REQUIRED_SUCCESSES=3

fail() { echo "$1" >&2; return 1; }

active_spark_count() {
  kubectl get sparkapplications -n "$NAMESPACE" -o json | jq '
    [.items[]
      | (.status.applicationState.state // "UNKNOWN" | ascii_upcase) as $state
      | select($state | IN("UNKNOWN", "SUBMITTED", "PENDING_RERUN", "RUNNING", "FAILING"))
    ]
    | length
  '
}

wait_for_alb_steady() {
  local deadline=$((SECONDS + ALB_STEADY_TIMEOUT_SECONDS))
  local error_file="$TEMP_DIR/alb-steady-error.log"
  local steady_successes=0

  while true; do
    if bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady \
      >/dev/null 2>"$error_file"; then
      steady_successes=$((steady_successes + 1))
      if ((steady_successes >= ALB_STEADY_REQUIRED_SUCCESSES)); then
        return 0
      fi
    else
      steady_successes=0
      if ! grep -Eq \
        'healthy rollout floor|does not allow draining ALB targets|do not exactly match Ready EndpointSlice' \
        "$error_file"; then
        cat "$error_file" >&2
        return 1
      fi
    fi
    if ((SECONDS >= deadline)); then
      cat "$error_file" >&2
      echo "ALB did not reach steady state within ${ALB_STEADY_TIMEOUT_SECONDS}s" >&2
      return 1
    fi
    sleep "$ALB_STEADY_POLL_SECONDS"
  done
}

rollback_on_error() {
  local exit_code=$?
  trap - ERR
  set +e
  if [[ "$WEB_APPLIED" == "true" && "$WEB_REVISION_BEFORE" =~ ^[0-9]+$ ]]; then
    helm rollback "$WEB_RELEASE" "$WEB_REVISION_BEFORE" -n "$NAMESPACE" \
      --wait --timeout 10m >/dev/null
  fi
  if [[ "$RUNTIME_APPLIED" == "true" && "$RUNTIME_REVISION_BEFORE" =~ ^[0-9]+$ ]]; then
    helm rollback "$RUNTIME_RELEASE" "$RUNTIME_REVISION_BEFORE" -n "$NAMESPACE" \
      --wait --timeout 5m >/dev/null
  fi
  echo "spark_hybrid_activation=failed rollback_attempted=true" >&2
  exit "$exit_code"
}

cleanup() { rm -rf "$TEMP_DIR"; }
trap rollback_on_error ERR
trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--apply" ]] || \
  fail "usage: deploy-eks-spark-hybrid-activation.sh [--preflight|--apply]"
[[ "$ALB_STEADY_TIMEOUT_SECONDS" =~ ^[0-9]+$ \
  && "$ALB_STEADY_TIMEOUT_SECONDS" -ge 1 \
  && "$ALB_STEADY_TIMEOUT_SECONDS" -le 1800 ]] || \
  fail "ASKLAKE_ALB_STEADY_TIMEOUT_SECONDS must be between 1 and 1800"
[[ "$ALB_STEADY_POLL_SECONDS" =~ ^[0-9]+$ \
  && "$ALB_STEADY_POLL_SECONDS" -ge 1 \
  && "$ALB_STEADY_POLL_SECONDS" -le 60 ]] || \
  fail "ASKLAKE_ALB_STEADY_POLL_SECONDS must be between 1 and 60"
for command in git grep helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR" "$RECEIPT")" || \
  fail "current image receipt is invalid"
[[ "$(jq -er '.gitRevision' "$RECEIPT")" == "$(git -C "$ROOT_DIR" rev-parse HEAD)" ]] || \
  fail "image receipt must match the checked-out activation revision"

for values in "$BASE_RUNTIME" "$BASE_WEB" "$CANDIDATE_RUNTIME" "$CANDIDATE_WEB"; do
  [[ -s "$values" ]] || fail "private hybrid activation values are missing"
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || fail "private values must remain ignored"
  [[ "$(stat -f '%Lp' "$values")" == "600" ]] || fail "private values must use mode 0600"
done

node "$BUILDER" "$BASE_RUNTIME" "$BASE_WEB" "$RECEIPT" \
  >"$TEMP_DIR/expected.json"
jq -S -c '.runtimeValues' "$TEMP_DIR/expected.json" >"$TEMP_DIR/expected-runtime.json"
jq -S -c . "$CANDIDATE_RUNTIME" >"$TEMP_DIR/candidate-runtime.json"
cmp -s "$TEMP_DIR/expected-runtime.json" "$TEMP_DIR/candidate-runtime.json" || \
  fail "runtime candidate is not the exact hybrid activation output"
jq -S -c '.webValues' "$TEMP_DIR/expected.json" >"$TEMP_DIR/expected-web.json"
jq -S -c . "$CANDIDATE_WEB" >"$TEMP_DIR/candidate-web.json"
cmp -s "$TEMP_DIR/expected-web.json" "$TEMP_DIR/candidate-web.json" || \
  fail "Web candidate is not the exact hybrid activation output"

jq -e --slurp '
  .[0].configMap.data as $base
  | .[1].configMap.data as $candidate
  | [
      (($base | keys) + ($candidate | keys))
      | unique[]
      | select($base[.] != $candidate[.])
    ] == [
      "ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES",
      "ASKLAKE_SPARK_KUBERNETES_IMAGE"
    ]
  and $candidate.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES == "10737418240"
' "$BASE_RUNTIME" "$CANDIDATE_RUNTIME" >/dev/null || \
  fail "runtime candidate changed more than threshold and Spark image"
jq -e --slurp '
  (.[0] | del(.backend.image, .backend.runtimeConfigRevision))
    == (.[1] | del(.backend.image, .backend.runtimeConfigRevision))
  and .[0].backend.image != .[1].backend.image
  and .[0].backend.runtimeConfigRevision != .[1].backend.runtimeConfigRevision
  and (.[1].backend.runtimeConfigRevision | test("^spark-hybrid-[a-f0-9]{16}$"))
' "$BASE_WEB" "$CANDIDATE_WEB" >/dev/null || \
  fail "Web candidate changed more than Backend image and runtime revision"

verify_asklake_eks_context
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json >"$TEMP_DIR/live-runtime.json"
jq -e --arg release "$RUNTIME_RELEASE" --arg namespace "$NAMESPACE" '
  .metadata.labels["app.kubernetes.io/managed-by"] == "Helm"
  and .metadata.annotations["meta.helm.sh/release-name"] == $release
  and .metadata.annotations["meta.helm.sh/release-namespace"] == $namespace
' "$TEMP_DIR/live-runtime.json" >/dev/null || fail "runtime ConfigMap has an unexpected owner"
jq -S -c '.data' "$TEMP_DIR/live-runtime.json" >"$TEMP_DIR/live-runtime-data.json"
jq -S -c '.configMap.data' "$BASE_RUNTIME" >"$TEMP_DIR/base-runtime-data.json"
cmp -s "$TEMP_DIR/live-runtime-data.json" "$TEMP_DIR/base-runtime-data.json" || \
  fail "live runtime ConfigMap drifted from the captured base"
helm get values "$WEB_RELEASE" -n "$NAMESPACE" -o json \
  | jq -S -c . >"$TEMP_DIR/live-web.json"
jq -S -c . "$BASE_WEB" >"$TEMP_DIR/base-web.json"
cmp -s "$TEMP_DIR/live-web.json" "$TEMP_DIR/base-web.json" || \
  fail "live Web release drifted from the captured base"
[[ "$(active_spark_count)" == "0" ]] || fail "active SparkApplications must be zero before activation"

helm lint "$RUNTIME_CHART" -f "$CANDIDATE_RUNTIME" >/dev/null
helm lint "$WEB_CHART" -f "$CANDIDATE_WEB" >/dev/null
helm template "$RUNTIME_RELEASE" "$RUNTIME_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_RUNTIME" >"$TEMP_DIR/runtime-rendered.yaml"
helm template "$WEB_RELEASE" "$WEB_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_WEB" >"$TEMP_DIR/web-rendered.yaml"
runtime_revision="$(jq -r '.runtimeConfigRevision' "$TEMP_DIR/expected.json")"
[[ "$(grep -c "asklake.io/runtime-config-revision: \"$runtime_revision\"" "$TEMP_DIR/web-rendered.yaml")" == "2" ]] || \
  fail "Web candidate does not restart FastAPI and Collector on one runtime revision"

RUNTIME_REVISION_BEFORE="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "'"$RUNTIME_RELEASE"'") | .revision')"
WEB_REVISION_BEFORE="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "'"$WEB_RELEASE"'") | .revision')"
helm upgrade --install "$RUNTIME_RELEASE" "$RUNTIME_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_RUNTIME" --dry-run=server >/dev/null
helm upgrade --install "$WEB_RELEASE" "$WEB_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_WEB" --dry-run=server >/dev/null
[[ "$(active_spark_count)" == "0" ]] || fail "a SparkApplication started during activation preflight"

if [[ "$MODE" == "--preflight" ]]; then
  trap - ERR
  echo "spark_hybrid_activation=preflight_passed cluster_mutation=zero active_spark=0"
  exit 0
fi

[[ "${ASKLAKE_SPARK_HYBRID_ACTIVATION_CONFIRM:-}" == "activate-10gib-spark-hybrid" ]] || \
  fail "set ASKLAKE_SPARK_HYBRID_ACTIVATION_CONFIRM=activate-10gib-spark-hybrid"

helm upgrade --install "$RUNTIME_RELEASE" "$RUNTIME_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_RUNTIME" --rollback-on-failure --wait --timeout 5m >/dev/null
RUNTIME_APPLIED=true
helm upgrade --install "$WEB_RELEASE" "$WEB_CHART" -n "$NAMESPACE" \
  -f "$CANDIDATE_WEB" --rollback-on-failure --wait --timeout 10m >/dev/null
WEB_APPLIED=true
kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=10m >/dev/null
kubectl rollout status deployment/trino-result-collector -n "$NAMESPACE" --timeout=10m >/dev/null

kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json \
  | jq -S -c '.data' >"$TEMP_DIR/live-runtime-after.json"
if cmp -s "$TEMP_DIR/live-runtime-after.json" "$TEMP_DIR/base-runtime-data.json"; then
  fail "runtime ConfigMap did not change"
fi
jq -S -c '.configMap.data' "$CANDIDATE_RUNTIME" >"$TEMP_DIR/candidate-runtime-data.json"
cmp -s "$TEMP_DIR/live-runtime-after.json" "$TEMP_DIR/candidate-runtime-data.json" || \
  fail "runtime ConfigMap did not converge on the hybrid candidate"
helm get values "$WEB_RELEASE" -n "$NAMESPACE" -o json \
  | jq -S -c . >"$TEMP_DIR/live-web-after.json"
cmp -s "$TEMP_DIR/live-web-after.json" "$TEMP_DIR/candidate-web.json" || \
  fail "Web release did not converge on the hybrid candidate"

expected_backend_image="$(jq -r '.images.backend' "$RECEIPT")"
expected_spark_image="$(jq -r '.images.sparkRuntime' "$RECEIPT")"
kubectl get deployment fastapi trino-result-collector -n "$NAMESPACE" -o json \
  >"$TEMP_DIR/deployments-after.json"
jq -e --arg image "$expected_backend_image" --arg revision "$runtime_revision" '
  (.items | length) == 2
  and all(.items[];
    (.status.readyReplicas // 0) == (.spec.replicas // 0)
    and .spec.template.metadata.annotations["asklake.io/runtime-config-revision"] == $revision
    and all(.spec.template.spec.containers[]; .image == $image)
  )
' "$TEMP_DIR/deployments-after.json" >/dev/null || \
  fail "FastAPI and Collector did not converge on the Backend image and runtime revision"
jq -e --arg image "$expected_spark_image" '
  .configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE == $image
  and .configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES == "10737418240"
' "$CANDIDATE_RUNTIME" >/dev/null || fail "candidate threshold or Spark image is invalid"

for component in backend trino-result-collector; do
  pod="$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/component=$component" \
    -o json | jq -r '[.items[] | select(
      .metadata.deletionTimestamp == null
      and any(.status.containerStatuses[]?; .ready == true)
    )][0].metadata.name')"
  container="$([[ "$component" == "backend" ]] && echo fastapi || echo trino-result-collector)"
  [[ "$(kubectl exec -n "$NAMESPACE" "$pod" -c "$container" -- \
    printenv ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES)" == "10737418240" ]] || \
    fail "$component Pod did not receive the 10GiB threshold"
done
wait_for_alb_steady

RUNTIME_APPLIED=false
WEB_APPLIED=false
trap - ERR
echo "spark_hybrid_activation=applied threshold_bytes=10737418240 backend_ready=2 collector_ready=1"
echo "spark_hybrid_activation_rollback=helm_rollback_web_${WEB_REVISION_BEFORE}_runtime_${RUNTIME_REVISION_BEFORE}"
