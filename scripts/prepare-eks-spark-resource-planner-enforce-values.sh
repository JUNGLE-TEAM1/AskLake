#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_VALUES="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
OUTPUT="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-enforce.runtime-config-values.json}"
BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-enforce-values.mjs"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$BASE_VALUES" ]] || fail "captured live shadow runtime values are missing"
[[ "$(stat -f '%Lp' "$BASE_VALUES")" == "600" ]] || \
  fail "captured live shadow runtime values must use mode 0600"
for values in "$BASE_VALUES" "$OUTPUT"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || \
    fail "runtime ConfigMap values must remain ignored"
done

temporary="$(mktemp)"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

node "$BUILDER" "$BASE_VALUES" >"$temporary"
jq -e --slurp '
  .[0] as $base
  | .[1] as $candidate
  | (
      [
        (($base.configMap.data | keys) + ($candidate.configMap.data | keys))
        | unique[]
        | select($base.configMap.data[.] != $candidate.configMap.data[.])
      ]
      | sort
    ) == ["ASKLAKE_SPARK_RESOURCE_PLANNER_MODE"]
  and $base.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE == "shadow"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE == "enforce"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS == "4"
  and $candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES == "1"
' "$BASE_VALUES" "$temporary" >/dev/null || \
  fail "enforce candidate is not the approved shadow-to-enforce mode-only delta"

mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
printf 'spark_resource_planner_enforce_values=prepared delta_keys=1\n'
