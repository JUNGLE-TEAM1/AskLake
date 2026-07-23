#!/usr/bin/env bash

set -euo pipefail
if [[ "${ASKLAKE_TEST_DEBUG:-false}" == "true" ]]; then set -x; else set +x; fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT_DIR/scripts/run-eks-catalog-physical-read-smoke.sh"
TEST_ID="$$"
RECEIPT_PATH="$ROOT_DIR/infra/eks/delivery/.physical-read-test-${TEST_ID}.image-receipt.json"
INPUT_PATH="$ROOT_DIR/infra/eks/delivery/.physical-read-test-${TEST_ID}.physical-read-input.json"
TEMP_DIR="$(mktemp -d)"
FAKE_BIN="$TEMP_DIR/bin"
FAKE_LOG="$TEMP_DIR/fake-kubectl.log"
CAPTURED_MANIFEST="$TEMP_DIR/captured-manifest.yaml"
SENSITIVE_MARKER="private-object-${TEST_ID}"

cleanup() {
  rm -f "$RECEIPT_PATH" "$INPUT_PATH"
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN"
cp "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" "$RECEIPT_PATH"

write_valid_input() {
  jq -n --arg marker "$SENSITIVE_MARKER" '{
    datasetId: "private-dataset",
    materializationRoot: "s3a://private-bucket/materialization",
    objectUri: ("s3a://private-bucket/materialization/" + $marker + ".parquet")
  }' >"$INPUT_PATH"
}
write_valid_input

assert_fails() {
  local output_file="$1"
  shift
  if "$@" >"$output_file" 2>&1; then
    echo "expected command to fail" >&2
    exit 1
  fi
}

assert_private_marker_absent() {
  ! grep -q "$SENSITIVE_MARKER" "$1"
}

validate_only() {
  ASKLAKE_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$INPUT_PATH" \
    "$RUNNER" --validate-only
}

validate_output="$TEMP_DIR/validate.out"
validate_only >"$validate_output"
jq -e '.mode == "validate-only" and .manifestValidated == true and .evidenceScope == "bounded-s3-parquet-object"' \
  "$validate_output" >/dev/null
assert_private_marker_absent "$validate_output"

jq '.objectUri = "s3a://private-bucket/outside/file.parquet"' "$INPUT_PATH" >"$TEMP_DIR/input.json"
mv "$TEMP_DIR/input.json" "$INPUT_PATH"
assert_fails "$TEMP_DIR/outside.out" validate_only
! grep -q 'private-bucket' "$TEMP_DIR/outside.out"

write_valid_input
jq '.objectUri = "s3a://private-bucket/materialization/../private.parquet"' "$INPUT_PATH" >"$TEMP_DIR/input.json"
mv "$TEMP_DIR/input.json" "$INPUT_PATH"
assert_fails "$TEMP_DIR/noncanonical.out" validate_only
assert_private_marker_absent "$TEMP_DIR/noncanonical.out"

write_valid_input
jq '.objectUri += "?versionId=private"' "$INPUT_PATH" >"$TEMP_DIR/input.json"
mv "$TEMP_DIR/input.json" "$INPUT_PATH"
assert_fails "$TEMP_DIR/query.out" validate_only
assert_private_marker_absent "$TEMP_DIR/query.out"

write_valid_input
jq '.platform = "linux/arm64"' "$RECEIPT_PATH" >"$TEMP_DIR/receipt.json"
mv "$TEMP_DIR/receipt.json" "$RECEIPT_PATH"
assert_fails "$TEMP_DIR/arm64.out" validate_only
assert_private_marker_absent "$TEMP_DIR/arm64.out"
cp "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" "$RECEIPT_PATH"

ASKLAKE_EKS_NAMESPACE='INVALID_NAMESPACE' assert_fails "$TEMP_DIR/namespace.out" validate_only
AWS_REGION='invalid region' assert_fails "$TEMP_DIR/region.out" validate_only
ASKLAKE_PHYSICAL_READ_POLL_SECONDS=0 assert_fails "$TEMP_DIR/poll-zero.out" validate_only
ASKLAKE_PHYSICAL_READ_POLL_SECONDS=31 assert_fails "$TEMP_DIR/poll-high.out" validate_only
ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS=3601 assert_fails "$TEMP_DIR/timeout-high.out" validate_only

cp "$INPUT_PATH" "$TEMP_DIR/unignored-input.json"
if ASKLAKE_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$TEMP_DIR/unignored-input.json" \
  "$RUNNER" --validate-only >"$TEMP_DIR/unignored.out" 2>&1; then
  echo "unignored physical read input was accepted" >&2
  exit 1
fi

write_valid_input

cat >"$FAKE_BIN/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"eks describe-cluster"* ]]; then
  echo "https://fake-eks.invalid"
  exit 0
fi
if [[ "$*" == *"eks list-pod-identity-associations"* ]]; then
  [[ "${FAKE_MODE:-success}" != "pod-identity-missing" ]] || { echo '{"associations":[]}'; exit 0; }
  echo '{"associations":[{"associationId":"a-1"}]}'
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
if [[ "${1:-}" == "get" && "${2:-}" == "namespace" ]]; then exit 0; fi
if [[ "${1:-}" == "get" && "${2:-}" == "crd" && "$*" == *"-o json"* ]]; then
  [[ "${FAKE_MODE:-success}" != "crd-unready" ]] || { echo '{"status":{"conditions":[]}}'; exit 0; }
  echo '{"status":{"conditions":[{"type":"Established","status":"True"}]}}'
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "deployments" && "$*" == *"-o json"* ]]; then
  [[ "${FAKE_MODE:-success}" != "operator-unready" ]] || { echo '{"items":[{"status":{"availableReplicas":0}}]}'; exit 0; }
  echo '{"items":[{"status":{"availableReplicas":1}}]}'
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "serviceaccount" ]]; then exit 0; fi
if [[ "${1:-}" == "get" && ( "${2:-}" == "nodepool/asklake-spark" || "${2:-}" == "nodeclass/asklake-spark" ) ]]; then
  [[ "${FAKE_MODE:-success}" != "capacity-unready" ]] || { echo '{"status":{"conditions":[]}}'; exit 0; }
  if [[ "${2:-}" == "nodepool/asklake-spark" ]]; then
    echo '{"spec":{"template":{"spec":{"requirements":[{"key":"kubernetes.io/arch","values":["amd64"]}]}}},"status":{"conditions":[{"type":"Ready","status":"True"}]}}'
  else
    echo '{"status":{"conditions":[{"type":"Ready","status":"True"}]}}'
  fi
  exit 0
fi
if [[ "${1:-}" == "apply" ]]; then
  manifest_path=""
  for ((i=1; i <= $#; i++)); do
    if [[ "${!i}" == "-f" ]]; then next=$((i + 1)); manifest_path="${!next}"; fi
  done
  [[ -n "$manifest_path" ]] || exit 1
  cp "$manifest_path" "$FAKE_CAPTURED_MANIFEST"
  if [[ "$*" == *"--dry-run=server"* ]]; then
    [[ "${FAKE_MODE:-success}" != "dry-run-failure" ]]
    exit
  fi
  [[ "${FAKE_MODE:-success}" != "apply-failure" ]]
  exit
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
  [[ "${FAKE_MODE:-success}" != "audit-api-failure" ]] || exit 1
  if [[ "${FAKE_MODE:-success}" == "residue" ]]; then echo 'pod/asklake-physical-read-residue'; fi
  if [[ "${FAKE_MODE:-success}" == "prefix-orphan" && "$*" != *"-l asklake.io/physical-read-run="* ]]; then
    count_file="${FAKE_PREFIX_COUNT_FILE}"
    count="$(cat "$count_file" 2>/dev/null || echo 0)"
    app_name="$(awk '/^kind: SparkApplication$/ { found=1 } found && /^  name: / { print $2; exit }' "$FAKE_CAPTURED_MANIFEST")"
    if [[ "$count" -eq 0 ]]; then echo "pod/${app_name}-orphan"; fi
    echo $((count + 1)) >"$count_file"
  fi
  exit 0
fi
if [[ "${1:-}" == "auth" && "${2:-}" == "can-i" ]]; then
  if [[ "${FAKE_MODE:-success}" == "secret-access-error" ]]; then exit 2; fi
  if [[ "${FAKE_MODE:-success}" == "secret-access-allowed" ]]; then echo "yes"; exit 0; fi
  echo "no"
  exit 1
fi

echo "unexpected kubectl command" >&2
exit 97
EOF
chmod +x "$FAKE_BIN/aws" "$FAKE_BIN/kubectl"

run_live() {
  PATH="$FAKE_BIN:$PATH" \
  FAKE_KUBECTL_LOG="$FAKE_LOG" \
  FAKE_CAPTURED_MANIFEST="$CAPTURED_MANIFEST" \
  FAKE_PREFIX_COUNT_FILE="$TEMP_DIR/prefix-count" \
  ASKLAKE_EKS_CLUSTER_NAME="fake-cluster" \
  ASKLAKE_IMAGE_RECEIPT="$RECEIPT_PATH" \
  ASKLAKE_PHYSICAL_READ_INPUT="$INPUT_PATH" \
  ASKLAKE_PHYSICAL_READ_CONFIRM="run-bounded-physical-read" \
  ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS="${ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS:-2}" \
  ASKLAKE_PHYSICAL_READ_POLL_SECONDS="0.1" \
  FAKE_MODE="${FAKE_MODE:-success}" \
    "$RUNNER" --live
}

: >"$FAKE_LOG"
rm -f "$TEMP_DIR/prefix-count"
FAKE_MODE=success run_live >"$TEMP_DIR/live-success.out"
jq -e '
  .terminalState == "COMPLETED"
  and .evidenceScope == "bounded-s3-parquet-object"
  and .columnCount == 22
  and .returnedRows == 5
  and .rowWidthMatched == true
  and .residueCount == 0
' "$TEMP_DIR/live-success.out" >/dev/null
assert_private_marker_absent "$TEMP_DIR/live-success.out"
grep -q -- '--dry-run=server' "$FAKE_LOG"
grep -q '^apply -f ' "$FAKE_LOG"
grep -q '^delete ' "$FAKE_LOG"

# Manifest checks are independent of the runner's own grep assertions.
grep -q '^kind: ConfigMap$' "$CAPTURED_MANIFEST"
grep -q '^kind: SparkApplication$' "$CAPTURED_MANIFEST"
test "$(grep -c 'serviceAccount: asklake-spark' "$CAPTURED_MANIFEST")" -eq 2
test "$(grep -c 'kubernetes.io/arch: amd64' "$CAPTURED_MANIFEST")" -eq 2
test "$(grep -c 'asklake.io/workload-class: spark' "$CAPTURED_MANIFEST")" -eq 2
! grep -Eq 'kind: Secret|AKIA[0-9A-Z]{16}|aws_secret_access_key' "$CAPTURED_MANIFEST"

for failure_mode in \
  crd-unready operator-unready capacity-unready pod-identity-missing dry-run-failure apply-failure \
  failed invalid-result zero-columns width-mismatch missing-result residue cleanup-failure audit-api-failure \
  secret-access-error secret-access-allowed; do
  : >"$FAKE_LOG"
  rm -f "$TEMP_DIR/prefix-count"
  FAKE_MODE="$failure_mode" assert_fails "$TEMP_DIR/${failure_mode}.out" run_live
  assert_private_marker_absent "$TEMP_DIR/${failure_mode}.out"
  if [[ "$failure_mode" != crd-unready && "$failure_mode" != operator-unready && "$failure_mode" != capacity-unready && \
        "$failure_mode" != pod-identity-missing && "$failure_mode" != dry-run-failure ]]; then
    grep -q '^delete ' "$FAKE_LOG"
  fi
done

: >"$FAKE_LOG"
rm -f "$TEMP_DIR/prefix-count"
FAKE_MODE=prefix-orphan run_live >"$TEMP_DIR/prefix-orphan.out"
grep -Eq '^delete pod/asklake-physical-read-[^ ]+-orphan ' "$FAKE_LOG"

: >"$FAKE_LOG"
rm -f "$TEMP_DIR/prefix-count"
ASKLAKE_PHYSICAL_READ_TIMEOUT_SECONDS=1 FAKE_MODE=timeout \
  assert_fails "$TEMP_DIR/timeout.out" run_live
grep -q '^delete ' "$FAKE_LOG"
assert_private_marker_absent "$TEMP_DIR/timeout.out"

: >"$FAKE_LOG"
rm -f "$TEMP_DIR/prefix-count"
PATH="$FAKE_BIN:$PATH" \
FAKE_KUBECTL_LOG="$FAKE_LOG" \
FAKE_CAPTURED_MANIFEST="$CAPTURED_MANIFEST" \
FAKE_PREFIX_COUNT_FILE="$TEMP_DIR/prefix-count" \
ASKLAKE_EKS_CLUSTER_NAME="fake-cluster" \
ASKLAKE_IMAGE_RECEIPT="$RECEIPT_PATH" \
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
assert_private_marker_absent "$TEMP_DIR/interrupt.out"

echo "EKS bounded S3 Parquet physical read smoke regression scenarios passed."
