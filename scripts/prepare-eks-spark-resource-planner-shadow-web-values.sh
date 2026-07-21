#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_WEB_VALUES="${ASKLAKE_WEB_BASE_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.web.private-values.json}"
RUNTIME_VALUES="${ASKLAKE_RUNTIME_CONFIG_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-shadow.runtime-config-values.json}"
OUTPUT="${ASKLAKE_WEB_VALUES:-$ROOT_DIR/infra/eks/values/workloads/dev.spark-resource-planner-shadow.web.private-values.json}"
BUILDER="$ROOT_DIR/scripts/build-eks-spark-resource-planner-shadow-web-values.mjs"

fail() {
  echo "$1" >&2
  exit 1
}

for command in git jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
for values in "$BASE_WEB_VALUES" "$RUNTIME_VALUES"; do
  [[ -s "$values" ]] || fail "private base or shadow runtime values are missing"
  [[ "$(stat -f '%Lp' "$values")" == "600" ]] || \
    fail "private input values must use mode 0600"
done
for values in "$BASE_WEB_VALUES" "$RUNTIME_VALUES" "$OUTPUT"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$values" || \
    fail "private values must remain ignored"
done

temporary="$(mktemp)"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

node "$BUILDER" "$BASE_WEB_VALUES" "$RUNTIME_VALUES" >"$temporary"
jq -e --slurp '
  .[0] as $base
  | .[1] as $candidate
  | ($base | del(.backend.runtimeConfigRevision))
    == ($candidate | del(.backend.runtimeConfigRevision))
  and ($candidate.backend.runtimeConfigRevision | test("^sprp-shadow-[0-9a-f]{16}$"))
  and $candidate.backend.runtimeConfigRevision !=
    ($base.backend.runtimeConfigRevision // "")
' "$BASE_WEB_VALUES" "$temporary" >/dev/null || \
  fail "shadow Web candidate changed more than backend.runtimeConfigRevision"

revision="$(jq -r '.backend.runtimeConfigRevision' "$temporary")"
mv "$temporary" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT
printf 'spark_resource_planner_shadow_web_values=prepared runtime_revision=%s\n' "$revision"
