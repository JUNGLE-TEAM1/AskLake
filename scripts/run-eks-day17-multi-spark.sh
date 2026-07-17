#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
SOURCE="$ROOT_DIR/backend/scripts/run_eks_day17_multi_spark.py"
OUTPUT="${ASKLAKE_DAY17_MULTI_SPARK_RECEIPT:-/private/tmp/asklake-day17-multi-spark-receipt.json}"
CANDIDATE_OUTPUT="${ASKLAKE_DAY17_MULTI_SPARK_CANDIDATE_RECEIPT:-/private/tmp/asklake-day17-multi-spark-candidates.json}"
RAW="$(mktemp)"
PREFLIGHT="$(mktemp)"

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  rm -f "$RAW" "$PREFLIGHT"
}

run_remote() {
  local mode="$1"
  kubectl exec -i deployment/fastapi \
    -n "$NAMESPACE" \
    -c fastapi \
    -- env "DAY17_MULTI_SPARK_MODE=$mode" python - <"$SOURCE"
}

trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--prepare" || "$MODE" == "--run" ]] || \
  fail "usage: run-eks-day17-multi-spark.sh [--preflight|--prepare|--run]"
for command in jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$SOURCE" ]] || fail "Day 17 multi-Spark runner source is missing"
chmod 600 "$RAW" "$PREFLIGHT"

run_remote preflight >"$PREFLIGHT"
jq -e '.contractVersion=="1.0" and (.status=="passed" or .status=="blocked")' \
  "$PREFLIGHT" >/dev/null || fail "Day 17 multi-Spark preflight returned an invalid document"

if [[ "$MODE" == "--prepare" ]]; then
  [[ "${ASKLAKE_DAY17_MULTI_SPARK_PREPARE_CONFIRM:-}" == "prepare-three-isolated-candidate-jobs" ]] || \
    fail "set ASKLAKE_DAY17_MULTI_SPARK_PREPARE_CONFIRM=prepare-three-isolated-candidate-jobs"
  [[ ! -e "$CANDIDATE_OUTPUT" ]] || \
    fail "private candidate receipt already exists; inspect it before any retry"
  run_remote prepare >"$RAW"
  jq -e '
    .contractVersion=="1.0"
    and (.status=="prepared" or .status=="blocked")
  ' "$RAW" >/dev/null || fail "Day 17 candidate preparation returned an invalid document"
  mv "$RAW" "$CANDIDATE_OUTPUT"
  chmod 600 "$CANDIDATE_OUTPUT"
  if ! jq -e '.status=="prepared" and .counts.candidateJobs==3 and .counts.createdRuns==0' \
    "$CANDIDATE_OUTPUT" >/dev/null; then
    jq -c '{status,counts,blockers}' "$CANDIDATE_OUTPUT"
    fail "Day 17 candidate preparation is blocked"
  fi
  jq -r \
    '"day17_multi_spark_candidates=prepared jobs="+(.counts.candidateJobs|tostring)+" created_runs="+(.counts.createdRuns|tostring)' \
    "$CANDIDATE_OUTPUT"
  exit 0
fi

if [[ "$MODE" == "--preflight" ]]; then
  if ! jq -e '.status=="passed" and ([.checks[]]|all)' "$PREFLIGHT" >/dev/null; then
    jq -c '{status,counts,blockers}' "$PREFLIGHT"
    fail "Day 17 multi-Spark preflight is blocked"
  fi
  jq -r \
    '"day17_multi_spark_preflight=passed scale_slots="+(.counts.scaleSlots|tostring)+" candidate_jobs="+(.counts.candidateJobs|tostring)+" active_runs="+(.counts.activeFixtureRuns|tostring)+" continuous_sessions="+(.counts.continuousSessions|tostring)' \
    "$PREFLIGHT"
  exit 0
fi

[[ "${ASKLAKE_DAY17_MULTI_SPARK_CONFIRM:-}" == "submit-three-isolated-spark-runs" ]] || \
  fail "set ASKLAKE_DAY17_MULTI_SPARK_CONFIRM=submit-three-isolated-spark-runs"
[[ ! -e "$OUTPUT" ]] || \
  fail "private multi-Spark receipt already exists; never auto-resubmit"
jq -n \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    contractVersion:"1.0",
    status:"armed",
    createdAt:$createdAt,
    warning:"Submission may be partial. Never auto-resubmit when this file exists."
  }' >"$OUTPUT"
chmod 600 "$OUTPUT"

run_remote submit >"$RAW"
jq -e '
  .contractVersion=="1.0"
  and (.status=="submitted" or .status=="partial" or .status=="blocked")
' "$RAW" >/dev/null || fail "Day 17 multi-Spark submission returned an invalid document"
mv "$RAW" "$OUTPUT"
chmod 600 "$OUTPUT"

if ! jq -e '.status=="submitted" and ([.checks[]]|all)' "$OUTPUT" >/dev/null; then
  jq -c '{status,counts,failures,blockers,warning}' "$OUTPUT"
  fail "Day 17 multi-Spark submission did not create exactly three isolated Runs"
fi
jq -r \
  '"day17_multi_spark=submitted runs="+(.counts.submittedRuns|tostring)+" groups="+(.counts.consumerGroups|tostring)+" tables="+(.counts.icebergTables|tostring)+" outputs="+(.counts.outputs|tostring)+" checkpoints="+(.counts.checkpoints|tostring)' \
  "$OUTPUT"
