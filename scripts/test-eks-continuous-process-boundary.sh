#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh"
ROLLOUT_BOUNDARY="$ROOT_DIR/scripts/lib/verify-eks-backend-rollout-boundary.sh"
TEMP_DIR="$(mktemp -d)"
FAKE_BIN="$TEMP_DIR/bin"
CALLS="$TEMP_DIR/calls"
pass_count=0

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN"

cat >"$FAKE_BIN/helm" <<'EOF'
#!/bin/bash
set -euo pipefail
[[ "$*" == "get values asklake-web -n asklake-dev -o json" ]]
case "${FAKE_PROFILE:-standard}" in
  standard)
    printf '%s\n' '{"deploymentProfile":"standard","backend":{"realtime":{"enabled":false,"apiControlPlane":"external_ec2","v1ApiEnabled":false,"v1OwnerGeneration":""}}}'
    ;;
  realtime-v1-only)
    printf '%s\n' '{"deploymentProfile":"realtime-v1-only","backend":{"realtime":{"enabled":false,"apiControlPlane":"local","v1ApiEnabled":true,"v1OwnerGeneration":"v1-generation"}}}'
    ;;
  invalid-realtime)
    printf '%s\n' '{"deploymentProfile":"realtime-v1-only","backend":{"realtime":{"enabled":false,"apiControlPlane":"local","v1ApiEnabled":false,"v1OwnerGeneration":"v1-generation"}}}'
    ;;
  *)
    printf '{"deploymentProfile":"%s"}\n' "$FAKE_PROFILE"
    ;;
esac
EOF

cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
case "$*" in
  "get pod -n asklake-dev -l app.kubernetes.io/component=backend -o json")
    printf '%s\n' '{"items":[{"metadata":{"name":"fastapi-a"}},{"metadata":{"name":"fastapi-b"}}]}'
    ;;
  *"printenv ASKLAKE_CONTINUOUS_CONTROL_PLANE")
    printf '%s\n' "${FAKE_FASTAPI_CONTROL_PLANE:-external_ec2}"
    ;;
  *"printenv KAFKA_CONTINUOUS_V1_API_ENABLED")
    printf '%s\n' "${FAKE_V1_API_ENABLED:-true}"
    ;;
  *"printenv KAFKA_CONTINUOUS_V1_OWNER_GENERATION")
    printf '%s\n' "${FAKE_FASTAPI_GENERATION:-v1-generation}"
    ;;
  *"python -c"*)
    printf '%s\n' "${FAKE_FASTAPI_PROCESS_COUNT:-0}"
    ;;
  "get deployment asklake-realtime-v1-worker -n asklake-dev -o json")
    ready="${FAKE_WORKER_READY:-1}"
    generation="${FAKE_WORKER_GENERATION:-v1-generation}"
    printf '{"metadata":{"annotations":{"asklake.io/owner-generation":"%s","asklake.io/previous-owner-fenced":"true"}},"spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"realtime-v1-worker","env":[{"name":"CONTINUOUS_CONTROL_PLANE","value":"worker"},{"name":"CONTINUOUS_WORKER_SCOPE","value":"all"},{"name":"CONTINUOUS_WORKER_OWNER","value":"eks-continuous-worker-v1"},{"name":"CONTINUOUS_WORKER_GENERATION","value":"%s"}]}]}}},"status":{"readyReplicas":%s,"updatedReplicas":%s,"availableReplicas":%s,"unavailableReplicas":0}}\n' \
      "$generation" "$generation" "$ready" "$ready" "$ready"
    ;;
  *)
    echo "unexpected kubectl command: $*" >&2
    exit 1
    ;;
esac
EOF

cat >"$FAKE_BIN/bash" <<'EOF'
#!/bin/bash
set -euo pipefail
name="${1##*/}"
case "$name" in
  verify-eks-continuous-process-boundary.sh)
    printf 'eks_continuous_control_plane=%s\n' "${FAKE_BOUNDARY_MODE:-external_ec2}"
    ;;
  verify-eks-external-ec2-instance.sh)
    echo external_ec2 >>"$FAKE_CALLS"
    [[ "${FAKE_EXTERNAL_EC2_READY:-true}" == "true" ]]
    ;;
  *)
    echo "unexpected script: $name" >&2
    exit 1
    ;;
esac
EOF

chmod +x "$FAKE_BIN/helm" "$FAKE_BIN/kubectl" "$FAKE_BIN/bash"

expect_pass() {
  if ! "$@" >/dev/null 2>&1; then
    echo "not ok - expected success: $*" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

expect_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "not ok - expected failure: $*" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

run_verifier() {
  env PATH="$FAKE_BIN:$PATH" ASKLAKE_EKS_NAMESPACE=asklake-dev "$@" /bin/bash "$VERIFIER"
}

expect_pass run_verifier env FAKE_PROFILE=standard FAKE_FASTAPI_CONTROL_PLANE=external_ec2
expect_fail run_verifier env FAKE_PROFILE=standard FAKE_FASTAPI_CONTROL_PLANE=local
expect_pass run_verifier env FAKE_PROFILE=realtime-v1-only FAKE_FASTAPI_CONTROL_PLANE=local
expect_fail run_verifier env FAKE_PROFILE=invalid-realtime FAKE_FASTAPI_CONTROL_PLANE=local
expect_fail run_verifier env FAKE_PROFILE=realtime-v1-only FAKE_FASTAPI_CONTROL_PLANE=local FAKE_FASTAPI_GENERATION=wrong
expect_fail run_verifier env FAKE_PROFILE=realtime-v1-only FAKE_FASTAPI_CONTROL_PLANE=local FAKE_WORKER_READY=0
expect_fail run_verifier env FAKE_PROFILE=realtime-v1-only FAKE_FASTAPI_CONTROL_PLANE=local FAKE_WORKER_GENERATION=wrong
expect_fail run_verifier env FAKE_PROFILE=realtime-v1-only FAKE_FASTAPI_CONTROL_PLANE=local FAKE_FASTAPI_PROCESS_COUNT=1
expect_fail run_verifier env FAKE_PROFILE=unknown

source "$ROLLOUT_BOUNDARY"
: >"$CALLS"
PATH="$FAKE_BIN:$PATH" FAKE_CALLS="$CALLS" FAKE_BOUNDARY_MODE=external_ec2 \
  verify_asklake_backend_rollout_boundary "$ROOT_DIR" >/dev/null
[[ "$(grep -c '^external_ec2$' "$CALLS")" -eq 1 ]]
pass_count=$((pass_count + 1))

: >"$CALLS"
PATH="$FAKE_BIN:$PATH" FAKE_CALLS="$CALLS" FAKE_BOUNDARY_MODE=realtime_v1_only \
  verify_asklake_backend_rollout_boundary "$ROOT_DIR" >/dev/null
[[ ! -s "$CALLS" ]]
pass_count=$((pass_count + 1))

if PATH="$FAKE_BIN:$PATH" FAKE_CALLS="$CALLS" FAKE_BOUNDARY_MODE=unsupported \
  verify_asklake_backend_rollout_boundary "$ROOT_DIR" >/dev/null 2>&1; then
  echo "not ok - rollout boundary accepted an unsupported mode" >&2
  exit 1
fi
pass_count=$((pass_count + 1))

if PATH="$FAKE_BIN:$PATH" FAKE_CALLS="$CALLS" FAKE_BOUNDARY_MODE=external_ec2 \
  FAKE_EXTERNAL_EC2_READY=false \
  verify_asklake_backend_rollout_boundary "$ROOT_DIR" >/dev/null 2>&1; then
  echo "not ok - rollout boundary accepted an unavailable external EC2 owner" >&2
  exit 1
fi
pass_count=$((pass_count + 1))

printf 'EKS Continuous process boundary regression summary: %d passed.\n' "$pass_count"
