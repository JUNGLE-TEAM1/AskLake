#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---verify}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
RECEIPT="${ASKLAKE_DAY17_MULTI_SPARK_RECEIPT:-/private/tmp/asklake-day17-multi-spark-baked-receipt.json}"
OUTPUT="${ASKLAKE_DAY17_MULTI_SPARK_RESULTS:-/private/tmp/asklake-day17-multi-spark-results.json}"
PYTHON_SOURCE="$ROOT_DIR/backend/scripts/verify_eks_day17_multi_spark_results.py"

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$MODE" == "--verify" ]] || \
  fail "usage: verify-eks-day17-multi-spark-results.sh [--verify]"
for command in jq kubectl stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$PYTHON_SOURCE" ]] || fail "Day 17 multi-Spark verifier source is missing"
[[ -s "$RECEIPT" ]] || fail "Day 17 multi-Spark private receipt is missing"
case "$RECEIPT" in
  /private/tmp/asklake-day17-*.json) ;;
  *) fail "Day 17 multi-Spark receipt must remain outside the repository under /private/tmp" ;;
esac
case "$OUTPUT" in
  /private/tmp/asklake-day17-*.json) ;;
  *) fail "Day 17 multi-Spark result must remain outside the repository under /private/tmp" ;;
esac
[[ "$(stat -f '%Lp' "$RECEIPT")" == "600" ]] || \
  fail "Day 17 multi-Spark private receipt must use mode 0600"
[[ ! -e "$OUTPUT" ]] || \
  fail "Day 17 multi-Spark result already exists; preserve it and choose a new output path"
jq -e '
  .status=="submitted"
  and (.privateIdentity|type=="array" and length==3)
  and ([.privateIdentity[].alias]|sort)==(["Run A","Run B","Run C"]|sort)
  and ([.privateIdentity[].expectedCount]|all(.==100))
' "$RECEIPT" >/dev/null || fail "Day 17 multi-Spark private receipt contract is invalid"

raw="$(mktemp)"
chmod 600 "$raw"
cleanup() {
  rm -f "$raw"
}
trap cleanup EXIT
code="$(sed -n '1,$p' "$PYTHON_SOURCE")"
exec_status=0
kubectl exec -i "deployment/fastapi" -c fastapi -n "$NAMESPACE" -- \
  python -c "$code" <"$RECEIPT" >"$raw" || exec_status=$?
[[ -s "$raw" ]] || fail "Day 17 multi-Spark verifier returned no sanitized result"
jq -e '
  .contractVersion=="1.0"
  and .mode=="read-only"
  and (.status=="passed" or .status=="failed" or .status=="blocked")
  and (has("privateIdentity")|not)
' "$raw" >/dev/null || fail "Day 17 multi-Spark verifier returned an invalid result"
mv "$raw" "$OUTPUT"
chmod 600 "$OUTPUT"
trap - EXIT

if [[ "$exec_status" -ne 0 ]] || ! jq -e '
  .status=="passed"
  and ([.checks[]]|all)
  and ([.runs[].checks[]]|all)
' "$OUTPUT" >/dev/null; then
  jq -r '"day17_multi_spark_results="+.status+" mode="+.mode+" error="+(.errorType//"verification_failed")' "$OUTPUT"
  exit 1
fi

jq -r '
  "day17_multi_spark_results="+.status
  +" runs="+(.counts.runs|tostring)
  +" rows="+(.counts.trinoVerifiedRows|tostring)+"/"+(.counts.expectedRows|tostring)
  +" files="+(.counts.dataFiles|tostring)
  +" materializations="+(.counts.materializations|tostring)
  +" isolation="+(.counts.consumerGroups|tostring)+"/3"
' "$OUTPUT"
