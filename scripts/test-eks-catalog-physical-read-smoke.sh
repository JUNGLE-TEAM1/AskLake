#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT_DIR/scripts/run-eks-catalog-physical-read-smoke.sh"
TEST_ID="$$"
RECEIPT_PATH="$ROOT_DIR/infra/eks/delivery/.physical-read-test-${TEST_ID}.image-receipt.json"
INPUT_PATH="$ROOT_DIR/infra/eks/delivery/.physical-read-test-${TEST_ID}.physical-read-input.json"
TEMP_DIR="$(mktemp -d)"
FAKE_BIN="$TEMP_DIR/bin"
FAKE_LOG="$TEMP_DIR/fake-kubectl.log"
SENSITIVE_MARKER="private-object-${TEST_ID}"

cleanup() {
  rm -f "$RECEIPT_PATH" "$INPUT_PATH"
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN"
cp "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" "$RECEIPT_PATH"
jq -n --arg marker "$SENSITIVE_MARKER" '{
  datasetId: "private-dataset",
  materializationRoot: "s3a://private-bucket/materialization",
  objectUri: ("s3a://private-bucket/materialization/" + $marker + ".parquet")
}' >"$INPUT_PATH"

assert_fails() {
  local output_file="$1"
  shift
  if "$@" >"$output_file" 2>&1; then
    echo "expected command to fail" >&2
    exit 1
  fi
}

validate_only() {
  ASKLAKE_EKS_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$INPUT_PATH" \
    "$RUNNER" --validate-only
}

validate_output="$TEMP_DIR/validate.out"
validate_only >"$validate_output"
jq -e '.mode == "validate-only" and .manifestValidated == true' "$validate_output" >/dev/null
! grep -q "$SENSITIVE_MARKER" "$validate_output"

jq '.objectUri = "s3a://private-bucket/outside/file.parquet"' "$INPUT_PATH" >"$TEMP_DIR/input.json"
mv "$TEMP_DIR/input.json" "$INPUT_PATH"
assert_fails "$TEMP_DIR/outside.out" validate_only
! grep -q 'private-bucket' "$TEMP_DIR/outside.out"

jq -n --arg marker "$SENSITIVE_MARKER" '{
  datasetId: "private-dataset",
  materializationRoot: "s3a://private-bucket/materialization",
  objectUri: ("s3a://private-bucket/materialization/" + $marker + ".parquet")
}' >"$INPUT_PATH"
jq '.platform = "linux/arm64"' "$RECEIPT_PATH" >"$TEMP_DIR/receipt.json"
mv "$TEMP_DIR/receipt.json" "$RECEIPT_PATH"
assert_fails "$TEMP_DIR/arm64.out" validate_only
! grep -q "$SENSITIVE_MARKER" "$TEMP_DIR/arm64.out"
cp "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" "$RECEIPT_PATH"

cp "$INPUT_PATH" "$TEMP_DIR/unignored-input.json"
if ASKLAKE_EKS_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$TEMP_DIR/unignored-input.json" \
  "$RUNNER" --validate-only >"$TEMP_DIR/unignored.out" 2>&1; then
  echo "unignored physical read input was accepted" >&2
  exit 1
fi

cat >"$FAKE_BIN/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"eks describe-cluster"* ]]; then
  echo "https://fake-eks.invalid"
  exit 0
fi
exit 1
EOF

cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_KUBECTL_LOG"

if [[ "${1:-}" == "config" && "${2:-}" == "view" ]]; then
  echo "https://fake-eks.invalid"
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "namespace" ]]; then
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "crd" ]]; then
  exit 0
fi
if [[ "${1:-}" == "apply" ]]; then
  exit 0
fi
if [[ "${1:-}" == "delete" ]]; then
  [[ "${FAKE_MODE:-success}" != "cleanup-failure" ]]
  exit
fi
if [[ "${1:-}" == "get" && "${2:-}" == "sparkapplication.sparkoperator.k8s.io" && "$*" == *"-o json"* ]]; then
  case "${FAKE_MODE:-success}" in
    failed) echo '{"status":{"applicationState":{"state":"FAILED"},"driverInfo":{"podName":"driver"}}}' ;;
    timeout) echo '{"status":{"applicationState":{"state":"RUNNING"},"driverInfo":{"podName":"driver"}}}' ;;
    *) echo '{"status":{"applicationState":{"state":"COMPLETED"},"driverInfo":{"podName":"driver"}}}' ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "logs" ]]; then
  case "${FAKE_MODE:-success}" in
    invalid-result) echo 'ASKLAKE_PHYSICAL_READ_RESULT={"columnCount":22,"returnedRows":0,"rowWidthMatched":true}' ;;
    zero-columns) echo 'ASKLAKE_PHYSICAL_READ_RESULT={"columnCount":0,"returnedRows":5,"rowWidthMatched":true}' ;;
    width-mismatch) echo 'ASKLAKE_PHYSICAL_READ_RESULT={"columnCount":22,"returnedRows":5,"rowWidthMatched":false}' ;;
    missing-result) echo 'driver completed without a structured marker' ;;
    *) echo 'ASKLAKE_PHYSICAL_READ_RESULT={"columnCount":22,"returnedRows":5,"rowWidthMatched":true}' ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "get" && "$*" == *"-o name"* ]]; then
  [[ "${FAKE_MODE:-success}" != "residue" ]] || echo 'pod/asklake-physical-read-residue'
  exit 0
fi
if [[ "${1:-}" == "auth" && "${2:-}" == "can-i" ]]; then
  echo "no"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/aws" "$FAKE_BIN/kubectl"

run_live() {
  PATH="$FAKE_BIN:$PATH" \
  FAKE_KUBECTL_LOG="$FAKE_LOG" \
  ASKLAKE_EKS_CLUSTER_NAME="fake-cluster" \
  ASKLAKE_EKS_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$INPUT_PATH" \
  ASKLAKE_PHYSICAL_READ_CONFIRM="run-bounded-physical-read" \
  ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS="${ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS:-2}" \
  ASKLAKE_PHYSICAL_READ_POLL_SECONDS="0.1" \
  FAKE_MODE="${FAKE_MODE:-success}" \
    "$RUNNER" --live
}

: >"$FAKE_LOG"
FAKE_MODE=success run_live >"$TEMP_DIR/live-success.out"
jq -e '
  .terminalState == "COMPLETED"
  and .columnCount == 22
  and .returnedRows == 5
  and .rowWidthMatched == true
  and .residueCount == 0
' "$TEMP_DIR/live-success.out" >/dev/null
! grep -q "$SENSITIVE_MARKER" "$TEMP_DIR/live-success.out"
grep -q '^delete ' "$FAKE_LOG"

for failure_mode in failed invalid-result zero-columns width-mismatch missing-result residue cleanup-failure; do
  : >"$FAKE_LOG"
  FAKE_MODE="$failure_mode" assert_fails "$TEMP_DIR/${failure_mode}.out" run_live
  ! grep -q "$SENSITIVE_MARKER" "$TEMP_DIR/${failure_mode}.out"
  grep -q '^delete ' "$FAKE_LOG"
done

: >"$FAKE_LOG"
ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS=1 FAKE_MODE=timeout \
  assert_fails "$TEMP_DIR/timeout.out" run_live
grep -q '^delete ' "$FAKE_LOG"
! grep -q "$SENSITIVE_MARKER" "$TEMP_DIR/timeout.out"

: >"$FAKE_LOG"
PATH="$FAKE_BIN:$PATH" \
FAKE_KUBECTL_LOG="$FAKE_LOG" \
ASKLAKE_EKS_CLUSTER_NAME="fake-cluster" \
ASKLAKE_EKS_IMAGE_RECEIPT="$RECEIPT_PATH" \
ASKLAKE_PHYSICAL_READ_INPUT="$INPUT_PATH" \
ASKLAKE_PHYSICAL_READ_CONFIRM="run-bounded-physical-read" \
ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS=30 \
ASKLAKE_PHYSICAL_READ_POLL_SECONDS=0.1 \
FAKE_MODE=timeout \
  "$RUNNER" --live >"$TEMP_DIR/interrupt.out" 2>&1 &
runner_pid=$!
sleep 0.2
kill -TERM "$runner_pid"
if wait "$runner_pid"; then
  echo "interrupted physical read runner exited successfully" >&2
  exit 1
fi
grep -q '^delete ' "$FAKE_LOG"
! grep -q "$SENSITIVE_MARKER" "$TEMP_DIR/interrupt.out"

echo "EKS Catalog physical read smoke regression scenarios passed."
