#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT_DIR/scripts/run-eks-day18-backend-rollout-round-trip.sh"
TEMP_DIR="$(mktemp -d)"
FAKE_BIN="$TEMP_DIR/bin"
STATE_DIR="$TEMP_DIR/state"
RECEIPT="$TEMP_DIR/candidate.image-receipt.json"
EC2_ENV="$TEMP_DIR/ec2.env"
EVIDENCE="$TEMP_DIR/private-evidence.json"
OUTPUT="$TEMP_DIR/output.txt"
PRIOR_DIGEST="sha256:1111111111111111111111111111111111111111111111111111111111111111"
CANDIDATE_DIGEST="sha256:2222222222222222222222222222222222222222222222222222222222222222"
FRONTEND_DIGEST="sha256:3333333333333333333333333333333333333333333333333333333333333333"
PRIOR_IMAGE="example.invalid/asklake/backend@$PRIOR_DIGEST"
CANDIDATE_IMAGE="example.invalid/asklake/backend@$CANDIDATE_DIGEST"
FRONTEND_IMAGE="example.invalid/asklake/frontend@$FRONTEND_DIGEST"
pass_count=0

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$STATE_DIR"
printf '%s\n' '{"images":{"backend":"example.invalid/asklake/backend@sha256:2222222222222222222222222222222222222222222222222222222222222222"}}' >"$RECEIPT"
printf '%s\n' 'ASKLAKE_EC2_INSTANCE_ID=i-0123456789abcdef0' >"$EC2_ENV"
chmod 0600 "$RECEIPT" "$EC2_ENV"

cat >"$FAKE_BIN/bash" <<'EOF'
#!/bin/bash
set -euo pipefail
script="${1:-}"
name="${script##*/}"
case "$name" in
  preflight-eks-backend-image-rollout.sh)
    echo preflight >>"$ASKLAKE_TEST_CALLS"
    ;;
  rollout-eks-backend-image.sh)
    echo rollout >>"$ASKLAKE_TEST_CALLS"
    count="$(cat "$ASKLAKE_TEST_STATE/rollout-count")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$ASKLAKE_TEST_STATE/rollout-count"
    if [[ "${ASKLAKE_TEST_FAIL_ROLLOUT_AT:-0}" == "$count" ]]; then
      exit 1
    fi
    printf '%s\n' candidate >"$ASKLAKE_TEST_STATE/workload"
    revision="$(cat "$ASKLAKE_TEST_STATE/revision")"
    printf '%s\n' "$((revision + 1))" >"$ASKLAKE_TEST_STATE/revision"
    ;;
  verify-eks-day15-alb-runtime.sh)
    echo steady >>"$ASKLAKE_TEST_CALLS"
    if [[ "${ASKLAKE_TEST_FAIL_PRIOR_STEADY_ONCE:-false}" == "true" \
      && "$(cat "$ASKLAKE_TEST_STATE/workload")" == "prior" \
      && ! -e "$ASKLAKE_TEST_STATE/prior-steady-failed" ]]; then
      : >"$ASKLAKE_TEST_STATE/prior-steady-failed"
      exit 1
    fi
    ;;
  verify-eks-continuous-process-boundary.sh)
    echo continuous >>"$ASKLAKE_TEST_CALLS"
    ;;
  verify-eks-external-ec2-instance.sh)
    echo external_ec2 >>"$ASKLAKE_TEST_CALLS"
    ;;
  *)
    echo "unexpected child script: $name" >&2
    exit 1
    ;;
esac
EOF

cat >"$FAKE_BIN/helm" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
  list)
    revision="$(cat "$ASKLAKE_TEST_STATE/revision")"
    printf '[{"name":"asklake-web","revision":"%s"}]\n' "$revision"
    ;;
  rollback)
    echo rollback >>"$ASKLAKE_TEST_CALLS"
    if [[ "${ASKLAKE_TEST_FAIL_ROLLBACK:-false}" == "true" ]]; then
      exit 1
    fi
    printf '%s\n' prior >"$ASKLAKE_TEST_STATE/workload"
    revision="$(cat "$ASKLAKE_TEST_STATE/revision")"
    printf '%s\n' "$((revision + 1))" >"$ASKLAKE_TEST_STATE/revision"
    ;;
  *)
    echo "unexpected helm command" >&2
    exit 1
    ;;
esac
EOF

cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
state="$(cat "$ASKLAKE_TEST_STATE/workload")"
if [[ "$state" == "candidate" ]]; then
  backend_image="$ASKLAKE_TEST_CANDIDATE_IMAGE"
  backend_digest="$ASKLAKE_TEST_CANDIDATE_DIGEST"
else
  backend_image="$ASKLAKE_TEST_PRIOR_IMAGE"
  backend_digest="$ASKLAKE_TEST_PRIOR_DIGEST"
fi

deployment() {
  local name="$1" container replicas
  if [[ "$name" == "fastapi" ]]; then
    container="fastapi"
    replicas=2
  elif [[ "$name" == "trino-result-collector" ]]; then
    container="trino-result-collector"
    replicas=1
  else
    printf '{"metadata":{"generation":4},"spec":{"template":{"spec":{"containers":[{"name":"frontend","image":"%s"}]}}}}\n' \
      "$ASKLAKE_TEST_FRONTEND_IMAGE"
    return
  fi
  printf '{"metadata":{"generation":8},"spec":{"replicas":%s,"template":{"spec":{"containers":[{"name":"%s","image":"%s"}]}}},"status":{"readyReplicas":%s,"updatedReplicas":%s,"availableReplicas":%s,"unavailableReplicas":0}}\n' \
    "$replicas" "$container" "$backend_image" "$replicas" "$replicas" "$replicas"
}

pods() {
  local component="$1" count container index
  if [[ "$component" == "frontend" ]]; then
    printf '{"items":[{"metadata":{"uid":"front-a"}},{"metadata":{"uid":"front-b"}}]}\n'
    return
  elif [[ "$component" == "backend" ]]; then
    count=2
    container="fastapi"
  else
    count=1
    container="trino-result-collector"
  fi
  printf '{"items":['
  for ((index=1; index<=count; index++)); do
    ((index > 1)) && printf ','
    printf '{"metadata":{"uid":"%s-%s","deletionTimestamp":null},"status":{"phase":"Running","containerStatuses":[{"name":"%s","ready":true,"restartCount":0,"imageID":"docker-pullable://example.invalid/asklake/backend@%s"}]}}' \
      "$component" "$index" "$container" "$backend_digest"
  done
  printf ']}\n'
}

case "$*" in
  "get deployment fastapi"*) deployment fastapi ;;
  "get deployment trino-result-collector"*) deployment trino-result-collector ;;
  "get deployment frontend"*) deployment frontend ;;
  *"get pods"*"app.kubernetes.io/component=backend"*) pods backend ;;
  *"get pods"*"app.kubernetes.io/component=trino-result-collector"*) pods collector ;;
  *"get pods"*"app.kubernetes.io/component=frontend"*) pods frontend ;;
  "get secret asklake-backend-runtime"*)
    printf '%s\n' '{"data":{"DATABASE_URL":"dmFsdWU="}}'
    ;;
  "get ingress asklake-backend"*)
    printf '%s\n' '{"status":{"loadBalancer":{"ingress":[{"hostname":"backend.example.invalid"}]}}}'
    ;;
  *)
    echo "unexpected kubectl command" >&2
    exit 1
    ;;
esac
EOF

cat >"$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
printf '200'
EOF

cat >"$FAKE_BIN/node" <<'EOF'
#!/bin/bash
exit 0
EOF

chmod +x "$FAKE_BIN/bash" "$FAKE_BIN/helm" "$FAKE_BIN/kubectl" "$FAKE_BIN/curl" "$FAKE_BIN/node"

reset_state() {
  printf '%s\n' prior >"$STATE_DIR/workload"
  printf '%s\n' 7 >"$STATE_DIR/revision"
  printf '%s\n' 0 >"$STATE_DIR/rollout-count"
  : >"$STATE_DIR/calls"
  : >"$OUTPUT"
  rm -f "$EVIDENCE"
  rm -f "$STATE_DIR/prior-steady-failed"
}

run_runner() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    ASKLAKE_DAY18_EC2_ENV="$EC2_ENV" \
    ASKLAKE_DAY18_EXECUTION_CONTRACT="$TEMP_DIR/approved.json" \
    ASKLAKE_DAY18_LIVE_INPUT="$TEMP_DIR/live-input.json" \
    ASKLAKE_EKS_CLUSTER_NAME=asklake-dev \
    ASKLAKE_DAY18_ROUND_TRIP_STEADY_TIMEOUT_SECONDS=5 \
    ASKLAKE_DAY18_ROUND_TRIP_STEADY_INTERVAL_SECONDS=0.1 \
    ASKLAKE_TEST_FAIL_PRIOR_STEADY_ONCE="${ASKLAKE_TEST_FAIL_PRIOR_STEADY_ONCE:-false}" \
    ASKLAKE_DAY18_ROUND_TRIP_PRIVATE_EVIDENCE="$EVIDENCE" \
    ASKLAKE_TEST_STATE="$STATE_DIR" \
    ASKLAKE_TEST_CALLS="$STATE_DIR/calls" \
    ASKLAKE_TEST_PRIOR_IMAGE="$PRIOR_IMAGE" \
    ASKLAKE_TEST_CANDIDATE_IMAGE="$CANDIDATE_IMAGE" \
    ASKLAKE_TEST_FRONTEND_IMAGE="$FRONTEND_IMAGE" \
    ASKLAKE_TEST_PRIOR_DIGEST="$PRIOR_DIGEST" \
    ASKLAKE_TEST_CANDIDATE_DIGEST="$CANDIDATE_DIGEST" \
    "$@"
}

assert_sanitized_output() {
  if grep -Fq "$PRIOR_IMAGE" "$OUTPUT" || grep -Fq "$CANDIDATE_IMAGE" "$OUTPUT" \
    || grep -Eq 'sha256:[0-9a-f]{64}' "$OUTPUT"; then
    echo "not ok - runner output exposed a private image identifier" >&2
    exit 1
  fi
}

reset_state
run_runner /bin/bash "$RUNNER" --preflight "$RECEIPT" >"$OUTPUT" 2>&1
[[ "$(cat "$STATE_DIR/workload")" == "prior" ]]
[[ "$(grep -c '^rollout$' "$STATE_DIR/calls" || true)" -eq 0 ]]
[[ "$(grep -c '^rollback$' "$STATE_DIR/calls" || true)" -eq 0 ]]
grep -Fq 'backend_round_trip_cluster_mutation=zero' "$OUTPUT"
[[ "$(stat -f '%Lp' "$EVIDENCE" 2>/dev/null || stat -c '%a' "$EVIDENCE")" == "600" ]]
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - preflight performs zero mutation"

reset_state
if run_runner /bin/bash "$RUNNER" --run "$RECEIPT" >"$OUTPUT" 2>&1; then
  echo "not ok - run mode accepted missing confirmation" >&2
  exit 1
fi
[[ "$(grep -c '^rollout$' "$STATE_DIR/calls" || true)" -eq 0 ]]
[[ "$(grep -c '^rollback$' "$STATE_DIR/calls" || true)" -eq 0 ]]
grep -Fq 'backend_round_trip_stopped_phase=preflight' "$OUTPUT"
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - run mode fails closed without confirmation"

reset_state
ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend \
  run_runner /bin/bash "$RUNNER" --run "$RECEIPT" >"$OUTPUT" 2>&1
[[ "$(grep -c '^rollout$' "$STATE_DIR/calls")" -eq 2 ]]
[[ "$(grep -c '^rollback$' "$STATE_DIR/calls")" -eq 1 ]]
[[ "$(cat "$STATE_DIR/workload")" == "candidate" ]]
expected_sequence=$'preflight\nrollout\nsteady\ncontinuous\nexternal_ec2\nrollback\nsteady\ncontinuous\nexternal_ec2\nrollout\nsteady\ncontinuous\nexternal_ec2'
[[ "$(cat "$STATE_DIR/calls")" == "$expected_sequence" ]]
[[ "$(jq -r '.state' "$EVIDENCE")" == "candidate_repromotion_passed" ]]
grep -Fq 'backend_round_trip_result=passed' "$OUTPUT"
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - candidate, rollback and re-promotion complete in order"

reset_state
ASKLAKE_TEST_FAIL_PRIOR_STEADY_ONCE=true \
ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend \
  run_runner /bin/bash "$RUNNER" --run "$RECEIPT" >"$OUTPUT" 2>&1
[[ "$(cat "$STATE_DIR/workload")" == "candidate" ]]
[[ -e "$STATE_DIR/prior-steady-failed" ]]
[[ "$(jq -r '.state' "$EVIDENCE")" == "candidate_repromotion_passed" ]]
grep -Fq 'backend_round_trip_result=passed' "$OUTPUT"
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - rollback waits through a transient non-steady state"

reset_state
if ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend \
  ASKLAKE_TEST_FAIL_ROLLBACK=true \
  run_runner /bin/bash "$RUNNER" --run "$RECEIPT" >"$OUTPUT" 2>&1; then
  echo "not ok - runner accepted a failed intentional rollback" >&2
  exit 1
fi
[[ "$(grep -c '^rollout$' "$STATE_DIR/calls")" -eq 1 ]]
[[ "$(grep -c '^rollback$' "$STATE_DIR/calls")" -eq 1 ]]
grep -Fq 'backend_round_trip_stopped_phase=intentional_rollback' "$OUTPUT"
grep -Fq 'backend_round_trip_additional_mutation=stopped' "$OUTPUT"
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - rollback failure stops before re-promotion"

reset_state
if ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend \
  ASKLAKE_TEST_FAIL_ROLLOUT_AT=2 \
  run_runner /bin/bash "$RUNNER" --run "$RECEIPT" >"$OUTPUT" 2>&1; then
  echo "not ok - runner accepted a failed re-promotion" >&2
  exit 1
fi
[[ "$(grep -c '^rollout$' "$STATE_DIR/calls")" -eq 2 ]]
[[ "$(grep -c '^rollback$' "$STATE_DIR/calls")" -eq 1 ]]
grep -Fq 'backend_round_trip_stopped_phase=candidate_repromotion' "$OUTPUT"
grep -Fq 'backend_round_trip_additional_mutation=stopped' "$OUTPUT"
assert_sanitized_output
pass_count=$((pass_count + 1))
echo "ok - re-promotion failure stops additional mutation"

printf 'Day 18 Backend rollout round-trip regression summary: %d passed.\n' "$pass_count"
