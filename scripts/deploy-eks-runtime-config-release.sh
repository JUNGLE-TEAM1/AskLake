#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
RELEASE="asklake-runtime-config"

[[ "${ASKLAKE_RUNTIME_CONFIG_CONFIRM:-}" == "take-ownership-with-exact-data" ]] || {
  echo "set ASKLAKE_RUNTIME_CONFIG_CONFIRM=take-ownership-with-exact-data" >&2
  exit 1
}
ASKLAKE_RUNTIME_CONFIG_RELEASE="$RELEASE" bash "$ROOT_DIR/scripts/verify-eks-runtime-config-release.sh" --preflight

before="$(mktemp)"; after="$(mktemp)"
trap 'rm -f "$before" "$after"' EXIT
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -S -c '.data' >"$before"
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$VALUES" \
  --take-ownership --rollback-on-failure --wait --timeout 5m >/dev/null
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -S -c '.data' >"$after"
cmp -s "$before" "$after" || {
  echo "runtime ConfigMap data changed during ownership migration" >&2
  exit 1
}
ASKLAKE_RUNTIME_CONFIG_RELEASE="$RELEASE" bash "$ROOT_DIR/scripts/verify-eks-runtime-config-release.sh" --owned
printf 'runtime_config_ownership=migrated data=unchanged\n'
