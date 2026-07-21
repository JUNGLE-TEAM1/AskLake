#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---from-files}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
BASE_RUNTIME="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.base.runtime-config-values.json}"
BASE_WEB="${ASKLAKE_WEB_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.base.private-values.json}"
RUNTIME_OUTPUT="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.runtime-config-values.json}"
WEB_OUTPUT="${ASKLAKE_WEB_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-hybrid.web.private-values.json}"
RECEIPT="${ASKLAKE_IMAGE_RECEIPT:-}"
BUILDER="$ROOT_DIR/scripts/build-eks-spark-hybrid-activation-values.mjs"

fail() { echo "$1" >&2; exit 1; }
[[ "$MODE" == "--capture-live" || "$MODE" == "--from-files" ]] || \
  fail "usage: prepare-eks-spark-hybrid-activation-values.sh [--capture-live|--from-files]"
for command in git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "$RECEIPT" && -s "$RECEIPT" ]] || fail "ASKLAKE_IMAGE_RECEIPT is required"

for output in "$BASE_RUNTIME" "$BASE_WEB" "$RUNTIME_OUTPUT" "$WEB_OUTPUT" "$RECEIPT"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$output" || fail "private values and receipt must remain ignored"
done

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
if [[ "$MODE" == "--capture-live" ]]; then
  kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json | jq -e '{
    namespace: .metadata.namespace,
    configMap: {name: .metadata.name, data: .data}
  } | select(.namespace == "asklake-dev" and .configMap.name == "asklake-runtime")' \
    >"$temporary_directory/base-runtime.json"
  helm get values asklake-web -n "$NAMESPACE" -o json \
    >"$temporary_directory/base-web.json"
  mv "$temporary_directory/base-runtime.json" "$BASE_RUNTIME"
  mv "$temporary_directory/base-web.json" "$BASE_WEB"
  chmod 600 "$BASE_RUNTIME" "$BASE_WEB"
fi

for input in "$BASE_RUNTIME" "$BASE_WEB" "$RECEIPT"; do
  [[ -s "$input" ]] || fail "private activation input is missing"
  [[ "$(stat -f '%Lp' "$input")" == "600" ]] || fail "private activation inputs must use mode 0600"
done

node "$BUILDER" "$BASE_RUNTIME" "$BASE_WEB" "$RECEIPT" \
  >"$temporary_directory/candidate.json"
jq '.runtimeValues' "$temporary_directory/candidate.json" \
  >"$temporary_directory/runtime.json"
jq '.webValues' "$temporary_directory/candidate.json" \
  >"$temporary_directory/web.json"
revision="$(jq -r '.runtimeConfigRevision' "$temporary_directory/candidate.json")"
mv "$temporary_directory/runtime.json" "$RUNTIME_OUTPUT"
mv "$temporary_directory/web.json" "$WEB_OUTPUT"
chmod 600 "$RUNTIME_OUTPUT" "$WEB_OUTPUT"

printf 'spark_hybrid_values=prepared threshold_bytes=%s runtime_revision=%s\n' \
  "10737418240" "$revision"
