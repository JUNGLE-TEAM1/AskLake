#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_VALUES="${ASKLAKE_RUNTIME_CONFIG_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.runtime-config-values.json}"
OUTPUT="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-shadow.runtime-config-values.json}"
BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-values.mjs"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$BASE_VALUES" ]] || fail "captured live runtime values are missing"
[[ "$(stat -f '%Lp' "$BASE_VALUES")" == "600" ]] || \
  fail "captured live runtime values must use mode 0600"
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
        (
          ($base.configMap.data | keys)
          + ($candidate.configMap.data | keys)
        )
        | unique[]
        | select($base.configMap.data[.] != $candidate.configMap.data[.])
      ]
      | sort
    ) as $changed
  | ($changed | length) >= 1
  and ($changed | index("ASKLAKE_SPARK_RESOURCE_PLANNER_MODE")) != null
  and all($changed[];
    . == "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES"
    or startswith("ASKLAKE_SPARK_RESOURCE_")
  )
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE == "shadow"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES == "134217728"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR == "384"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS == "1"
  and $candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS == "4"
  and $candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES == "1"
' "$BASE_VALUES" "$temporary" >/dev/null || \
  fail "shadow candidate differs from the approved Resource Planner-only delta"

delta_count="$(jq --slurp '
  .[0].configMap.data as $base
  | .[1].configMap.data as $candidate
  | [($base | keys) + ($candidate | keys) | unique[] | select($base[.] != $candidate[.])]
  | length
' "$BASE_VALUES" "$temporary")"
mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
printf 'spark_resource_planner_shadow_values=prepared key_count=%s delta_keys=%s\n' \
  "$(jq '.configMap.data | length' "$OUTPUT")" "$delta_count"
