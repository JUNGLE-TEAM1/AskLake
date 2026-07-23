#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
RELEASE="asklake-runtime-config"
MODE="${1:---preflight}"

fail() { echo "$1" >&2; exit 1; }
[[ "$MODE" == "--preflight" || "$MODE" == "--owned" ]] || fail "usage: verify-eks-runtime-config-release.sh [--preflight|--owned]"
for command in git helm jq kubectl node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || fail "current image receipt is invalid"
[[ -s "$VALUES" ]] || fail "private runtime ConfigMap values are missing"
git -C "$ROOT_DIR" check-ignore -q -- "$VALUES" || fail "private runtime ConfigMap values must remain ignored"
[[ "$(stat -f '%Lp' "$VALUES")" == "600" ]] || fail "private runtime ConfigMap values must use mode 0600"

temporary_directory="$(mktemp -d)"
live="$temporary_directory/live.json"; before="$temporary_directory/before.json"; after="$temporary_directory/after.json"
trap 'rm -rf "$temporary_directory"' EXIT
chmod 700 "$temporary_directory"
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json >"$live"
helm lint "$CHART" -f "$VALUES" >/dev/null
helm template "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" --output-dir "$temporary_directory/rendered" >/dev/null
rendered_manifest="$temporary_directory/rendered/asklake-runtime-config/templates/configmap.yaml"
[[ -s "$rendered_manifest" ]] || fail "runtime ConfigMap render is missing"

jq -S -c '.data' "$live" >"$before"
kubectl create --dry-run=client -f "$rendered_manifest" -o json | jq -S -c '.data' >"$after"
cmp -s "$before" "$after" || fail "rendered runtime ConfigMap data differs from live data"
expected_image="$(jq -r '.images.sparkRuntime' "$RECEIPT")"
actual_image="$(jq -r '.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE // empty' "$VALUES")"
[[ -n "$expected_image" && "$actual_image" == "$expected_image" ]] || fail "runtime ConfigMap Spark image differs from current receipt"

helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" \
  --take-ownership --dry-run=server >/dev/null
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -S -c '.data' >"$after"
cmp -s "$before" "$after" || fail "server dry-run changed live runtime ConfigMap data"

if [[ "$MODE" == "--owned" ]]; then
  ASKLAKE_RUNTIME_CONFIG_RELEASE="$RELEASE" \
    bash "$ROOT_DIR/scripts/verify-eks-runtime-config-ownership.sh" --ready >/dev/null
fi
printf 'runtime_config_release=%s mode=%s data=exact image=current\n' "$RELEASE" "${MODE#--}"
