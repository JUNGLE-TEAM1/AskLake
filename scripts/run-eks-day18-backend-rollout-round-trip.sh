#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---preflight}"
RECEIPT_PATH="${2:-${ASKLAKE_IMAGE_RECEIPT:-}}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
EC2_ENV="${ASKLAKE_DAY18_EC2_ENV:-$ROOT_DIR/deploy/ec2.env}"
PREFLIGHT="$ROOT_DIR/scripts/preflight-eks-backend-image-rollout.sh"
ROLLOUT="$ROOT_DIR/scripts/rollout-eks-backend-image.sh"
STEADY="$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh"
CONTINUOUS="$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh"
EXTERNAL_EC2="$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh"
APPROVAL_VERIFIER="$ROOT_DIR/scripts/verify-eks-day18-phase7-approval.mjs"
TEMP_DIR="$(mktemp -d)"
ROLLBACK_LOG="$TEMP_DIR/rollback.log"
ROLLBACK_MONITOR="$TEMP_DIR/rollback-http.txt"
MONITOR_PID=""
PHASE="input_validation"
PRIVATE_EVIDENCE="${ASKLAKE_DAY18_ROUND_TRIP_PRIVATE_EVIDENCE:-/private/tmp/asklake-day18-backend-round-trip-$$-$(date +%s).json}"
prior_revision=""
candidate_revision=""
rollback_revision=""
final_revision=""
prior_backend_image=""
candidate_backend_image=""
frontend_image_before=""
frontend_generation_before=""
frontend_pod_uids_before=""
secret_keys_before=""
secret_hash_before=""
STEADY_TIMEOUT_SECONDS="${ASKLAKE_DAY18_ROUND_TRIP_STEADY_TIMEOUT_SECONDS:-420}"
STEADY_INTERVAL_SECONDS="${ASKLAKE_DAY18_ROUND_TRIP_STEADY_INTERVAL_SECONDS:-5}"

fail() {
  echo "$1" >&2
  return 1
}

portable_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

stop_monitor() {
  if [[ -n "$MONITOR_PID" ]] && kill -0 "$MONITOR_PID" >/dev/null 2>&1; then
    kill "$MONITOR_PID" >/dev/null 2>&1 || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  MONITOR_PID=""
}

cleanup() {
  stop_monitor
  rm -rf "$TEMP_DIR"
}

on_error() {
  local exit_code=$?
  trap - ERR
  stop_monitor
  echo "backend_round_trip_stopped_phase=$PHASE" >&2
  echo "backend_round_trip_additional_mutation=stopped" >&2
  exit "$exit_code"
}

write_private_evidence() {
  local state="$1" temporary="$TEMP_DIR/private-evidence.json"
  umask 077
  jq -n \
    --arg state "$state" \
    --arg priorRevision "$prior_revision" \
    --arg candidateRevision "$candidate_revision" \
    --arg rollbackRevision "$rollback_revision" \
    --arg finalRevision "$final_revision" \
    --arg priorBackendImage "$prior_backend_image" \
    --arg candidateBackendImage "$candidate_backend_image" \
    '{
      schemaVersion: 1,
      state: $state,
      prior: {
        helmRevision: $priorRevision,
        backendImage: $priorBackendImage
      },
      candidate: {
        backendImage: $candidateBackendImage,
        firstPromotionRevision: $candidateRevision,
        rollbackRevision: $rollbackRevision,
        finalPromotionRevision: $finalRevision
      }
    }' >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$PRIVATE_EVIDENCE"
}

release_revision() {
  helm list -n "$NAMESPACE" -o json \
    | jq -r '.[] | select(.name == "asklake-web") | .revision'
}

deployment_image() {
  local deployment="$1" container="$2"
  kubectl get deployment "$deployment" -n "$NAMESPACE" -o json \
    | jq -r --arg container "$container" \
      '.spec.template.spec.containers[] | select(.name == $container) | .image'
}

assert_frontend_and_secret_unchanged() {
  local frontend_after frontend_image_after frontend_generation_after
  local frontend_pod_uids_after secret_after secret_keys_after secret_hash_after

  frontend_after="$(kubectl get deployment frontend -n "$NAMESPACE" -o json)"
  frontend_image_after="$(jq -r '.spec.template.spec.containers[] | select(.name == "frontend") | .image' <<<"$frontend_after")"
  frontend_generation_after="$(jq -r '.metadata.generation' <<<"$frontend_after")"
  frontend_pod_uids_after="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=frontend -o json \
    | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"
  [[ "$frontend_image_after" == "$frontend_image_before" ]] || fail "Frontend image changed during the Backend round trip"
  [[ "$frontend_generation_after" == "$frontend_generation_before" ]] || fail "Frontend generation changed during the Backend round trip"
  [[ "$frontend_pod_uids_after" == "$frontend_pod_uids_before" ]] || fail "Frontend Pods changed during the Backend round trip"

  secret_after="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
  secret_keys_after="$(jq -c '.data | keys | sort' <<<"$secret_after")"
  secret_hash_after="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$secret_after" | asklake_sha256)"
  [[ "$secret_keys_after" == "$secret_keys_before" && "$secret_hash_after" == "$secret_hash_before" ]] || \
    fail "Backend runtime Secret changed during the Backend round trip"
}

assert_backend_state() {
  local expected_image="$1" expected_digest="${1##*@}"
  local backend collector backend_pods collector_pods

  backend="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
  collector="$(kubectl get deployment trino-result-collector -n "$NAMESPACE" -o json)"
  backend_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json)"
  collector_pods="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=trino-result-collector -o json)"

  jq -e --arg image "$expected_image" '
    (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.updatedReplicas // 0) == 2
    and (.status.availableReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
    and ([.spec.template.spec.containers[] | select(.name == "fastapi") | .image] == [$image])
  ' <<<"$backend" >/dev/null || fail "FastAPI did not converge on the expected immutable image"

  jq -e --arg image "$expected_image" '
    (.spec.replicas // 0) == 1
    and (.status.readyReplicas // 0) == 1
    and (.status.updatedReplicas // 0) == 1
    and (.status.availableReplicas // 0) == 1
    and (.status.unavailableReplicas // 0) == 0
    and ([.spec.template.spec.containers[] | select(.name == "trino-result-collector") | .image] == [$image])
  ' <<<"$collector" >/dev/null || fail "Collector did not converge on the expected immutable image"

  jq -e --arg digest "$expected_digest" '
    (.items | length) == 2
    and all(.items[];
      .metadata.deletionTimestamp == null
      and .status.phase == "Running"
      and any(.status.containerStatuses[]?;
        .name == "fastapi"
        and .ready == true
        and .restartCount == 0
        and (.imageID | endswith($digest))
      )
    )
  ' <<<"$backend_pods" >/dev/null || fail "FastAPI Pods do not prove the expected immutable digest"

  jq -e --arg digest "$expected_digest" '
    (.items | length) == 1
    and all(.items[];
      .metadata.deletionTimestamp == null
      and .status.phase == "Running"
      and any(.status.containerStatuses[]?;
        .name == "trino-result-collector"
        and .ready == true
        and .restartCount == 0
        and (.imageID | endswith($digest))
      )
    )
  ' <<<"$collector_pods" >/dev/null || fail "Collector Pod does not prove the expected immutable digest"
}

verify_steady_phase() {
  local expected_image="$1"
  bash "$STEADY" --steady >/dev/null || return 1
  assert_backend_state "$expected_image" || return 1
  assert_frontend_and_secret_unchanged || return 1
  bash "$CONTINUOUS" >/dev/null || return 1
  bash "$EXTERNAL_EC2" >/dev/null || return 1
}

wait_for_steady_phase() {
  local expected_image="$1" deadline=$((SECONDS + STEADY_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    if verify_steady_phase "$expected_image" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$STEADY_INTERVAL_SECONDS"
  done
  fail "Backend round-trip state did not return to exact steady before the deadline"
}

monitor_rollback_health() {
  local code
  while true; do
    if ! code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 3 --max-time 10 "http://$backend_host/api/health" 2>/dev/null)"; then
      code="000"
    fi
    printf '%s\n' "$code" >>"$ROLLBACK_MONITOR"
    sleep 1
  done
}

trap on_error ERR
trap cleanup EXIT

if [[ "$MODE" != "--preflight" && "$MODE" != "--run" ]]; then
  fail "usage: $0 --preflight|--run [private-image-receipt.json]"
fi
for command in curl helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "$RECEIPT_PATH" && -s "$RECEIPT_PATH" ]] || fail "a private ASKLAKE_IMAGE_RECEIPT file is required"
[[ "$(portable_mode "$RECEIPT_PATH")" == "600" ]] || fail "private image receipt must use mode 0600"
[[ -s "$EC2_ENV" ]] || fail "private deploy/ec2.env is missing"
[[ "$(portable_mode "$EC2_ENV")" == "600" ]] || fail "deploy/ec2.env must use mode 0600"
case "$PRIVATE_EVIDENCE" in
  "$ROOT_DIR"|"$ROOT_DIR"/*) fail "private round-trip evidence must be stored outside the repository" ;;
esac
[[ -n "${ASKLAKE_DAY18_EXECUTION_CONTRACT:-}" ]] || fail "ASKLAKE_DAY18_EXECUTION_CONTRACT is required"
[[ -n "${ASKLAKE_DAY18_LIVE_INPUT:-}" ]] || fail "ASKLAKE_DAY18_LIVE_INPUT is required"
[[ -n "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]] || fail "ASKLAKE_EKS_CLUSTER_NAME is required"

node "$APPROVAL_VERIFIER" \
  --contract "$ASKLAKE_DAY18_EXECUTION_CONTRACT" \
  --live-input "$ASKLAKE_DAY18_LIVE_INPUT" \
  --candidate-receipt "$RECEIPT_PATH" \
  --ec2-env "$EC2_ENV" \
  --cluster "$ASKLAKE_EKS_CLUSTER_NAME" >/dev/null

set -a
source "$EC2_ENV"
set +a
export ASKLAKE_EXPECTED_EC2_INSTANCE_ID="${ASKLAKE_EC2_INSTANCE_ID:?}"

PHASE="preflight"
bash "$PREFLIGHT" "$RECEIPT_PATH" >/dev/null

prior_revision="$(release_revision)"
prior_backend_image="$(deployment_image fastapi fastapi)"
prior_collector_image="$(deployment_image trino-result-collector trino-result-collector)"
candidate_backend_image="$(jq -r '.images.backend' "$RECEIPT_PATH")"
[[ "$prior_revision" =~ ^[0-9]+$ ]] || fail "the current Helm release revision is unavailable"
[[ "$prior_backend_image" =~ @sha256:[0-9a-f]{64}$ ]] || fail "the current Backend image is not immutable"
[[ "$candidate_backend_image" =~ @sha256:[0-9a-f]{64}$ ]] || fail "the candidate Backend image is not immutable"
[[ "$prior_collector_image" == "$prior_backend_image" ]] || fail "FastAPI and Collector do not share the current Backend image"
[[ "$candidate_backend_image" != "$prior_backend_image" ]] || fail "the candidate Backend image is already deployed"

frontend_before="$(kubectl get deployment frontend -n "$NAMESPACE" -o json)"
frontend_image_before="$(jq -r '.spec.template.spec.containers[] | select(.name == "frontend") | .image' <<<"$frontend_before")"
frontend_generation_before="$(jq -r '.metadata.generation' <<<"$frontend_before")"
frontend_pod_uids_before="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=frontend -o json \
  | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"
secret_before="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
secret_keys_before="$(jq -c '.data | keys | sort' <<<"$secret_before")"
secret_hash_before="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$secret_before" | asklake_sha256)"
backend_host="$(kubectl get ingress asklake-backend -n "$NAMESPACE" -o json \
  | jq -r '.status.loadBalancer.ingress[0].hostname // empty')"
[[ -n "$backend_host" ]] || fail "the Backend ALB hostname is unavailable"

assert_backend_state "$prior_backend_image"
assert_frontend_and_secret_unchanged
write_private_evidence "preflight_passed"
echo "backend_round_trip_preflight=passed"
echo "backend_round_trip_private_evidence=mode_0600_outside_repository"
echo "backend_round_trip_planned_mutation=backend_image_only"

if [[ "$MODE" == "--preflight" ]]; then
  echo "backend_round_trip_cluster_mutation=zero"
  exit 0
fi

[[ "${ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM:-}" == "promote-rollback-repromote-immutable-backend" ]] || \
  fail "set ASKLAKE_DAY18_BACKEND_ROUND_TRIP_CONFIRM=promote-rollback-repromote-immutable-backend"

PHASE="candidate_promotion"
ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM=deploy-new-immutable-backend \
  bash "$ROLLOUT" "$RECEIPT_PATH"
candidate_revision="$(release_revision)"
[[ "$candidate_revision" =~ ^[0-9]+$ && "$candidate_revision" -gt "$prior_revision" ]] || \
  fail "candidate promotion did not advance the Helm release revision"
verify_steady_phase "$candidate_backend_image"
write_private_evidence "candidate_promotion_passed"
echo "backend_round_trip_candidate_promotion=passed"

PHASE="intentional_rollback"
monitor_rollback_health &
MONITOR_PID=$!
sleep 1
if ! helm rollback asklake-web "$prior_revision" \
  --namespace "$NAMESPACE" --wait --timeout 10m >"$ROLLBACK_LOG" 2>&1; then
  fail "intentional Helm rollback failed; manual steady-state recovery is required"
fi
wait_for_steady_phase "$prior_backend_image"
stop_monitor
rollback_samples="$(wc -l <"$ROLLBACK_MONITOR" | tr -d ' ')"
rollback_failures="$(awk '$1 != "200" {count++} END {print count+0}' "$ROLLBACK_MONITOR")"
[[ "$rollback_samples" -ge 1 && "$rollback_failures" -eq 0 ]] || \
  fail "external Backend health was not continuously available during intentional rollback"
rollback_revision="$(release_revision)"
[[ "$rollback_revision" =~ ^[0-9]+$ && "$rollback_revision" -gt "$candidate_revision" ]] || \
  fail "intentional rollback did not advance the Helm release revision"
write_private_evidence "intentional_rollback_passed"
echo "backend_round_trip_intentional_rollback=passed"
echo "backend_round_trip_rollback_http_samples=$rollback_samples"
echo "backend_round_trip_rollback_http_failures=$rollback_failures"

PHASE="candidate_repromotion"
ASKLAKE_BACKEND_IMAGE_ROLLOUT_CONFIRM=deploy-new-immutable-backend \
  bash "$ROLLOUT" "$RECEIPT_PATH"
final_revision="$(release_revision)"
[[ "$final_revision" =~ ^[0-9]+$ && "$final_revision" -gt "$rollback_revision" ]] || \
  fail "candidate re-promotion did not advance the Helm release revision"
verify_steady_phase "$candidate_backend_image"
write_private_evidence "candidate_repromotion_passed"
echo "backend_round_trip_candidate_repromotion=passed"
echo "backend_round_trip_final_fastapi=2_of_2"
echo "backend_round_trip_final_collector=1_of_1"
echo "backend_round_trip_frontend_mutation=zero"
echo "backend_round_trip_secret_mutation=zero"
echo "backend_round_trip_alb_rds_continuous_ec2=passed"
echo "backend_round_trip_result=passed"
