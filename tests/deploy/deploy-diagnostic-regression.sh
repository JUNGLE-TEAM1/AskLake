#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

pass_count=0
fail_count=0
PYTHON_BIN="$(command -v python3)"

record_pass() {
  printf 'ok - %s\n' "$1"
  pass_count=$((pass_count + 1))
}

record_fail() {
  printf 'not ok - %s\n' "$1" >&2
  fail_count=$((fail_count + 1))
}

make_fake_aws() {
  cat >"$TEMP_DIR/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
arguments="$*"
if [[ "$arguments" == *"State.Name"* ]]; then
  printf '%s\n' "${ASKLAKE_FAKE_INSTANCE_STATE:-running}"
else
  printf '198.51.100.10\n'
fi
EOF
  chmod +x "$TEMP_DIR/aws"
}

make_fake_curl() {
  cat >"$TEMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
if [[ "${ASKLAKE_FAKE_CURL_FAILURE:-}" == "backend" && "$url" == */api/health ]]; then
  exit 1
fi
case "$url" in
  */api/health)
    printf '%s\n' '{"ok":true,"statusCode":200,"database":{"ok":true}}'
    ;;
  */api/health/ai)
    printf '%s\n' '{"ok":true}'
    ;;
esac
EOF
  chmod +x "$TEMP_DIR/curl"
}

make_fake_ssh() {
  cat >"$TEMP_DIR/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command="${!#}"
if [[ "$command" == *"config --format json"* ]]; then
  printf '%s\n' '{"services":{"backend":{"environment":{"TRINO_ENABLED":"false","CLICKHOUSE_CONTINUOUS_JOIN_ENABLED":"false"}}}}'
fi
EOF
  chmod +x "$TEMP_DIR/ssh"
}

make_fake_aws
make_fake_curl
make_fake_ssh

run_diagnose() {
  local record_path="$1"
  shift
  local ssh_bin="${ASKLAKE_TEST_SSH_BIN:-$TEMP_DIR/ssh}"
  ASKLAKE_AWS_BIN="$TEMP_DIR/aws" \
    ASKLAKE_CURL_BIN="$TEMP_DIR/curl" \
    ASKLAKE_SSH_BIN="$ssh_bin" \
    ASKLAKE_PYTHON_BIN="$PYTHON_BIN" \
    ASKLAKE_EC2_INSTANCE_ID=i-deploy-diagnostic-test \
    ASKLAKE_EC2_HOST=asklake.example.test \
    ASKLAKE_APP_URL=https://asklake.example.test \
    ASKLAKE_DEPLOY_DIAGNOSTIC_PATH="$record_path" \
    "$@" \
    bash "$ROOT_DIR/scripts/deploy.sh" diagnose
}

success_record="$TEMP_DIR/success.json"
if run_diagnose "$success_record" env && "$PYTHON_BIN" - "$success_record" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
statuses = {item["name"]: item["status"] for item in record["checks"]}
assert record["schemaVersion"] == 1
assert record["overallStatus"] == "passed"
assert record["appUrl"] == "https://asklake.example.test"
assert record["instanceState"] == "running"
assert statuses == {
    "ec2_running": "passed",
    "canonical_url": "passed",
    "deploy_env_preflight": "passed",
    "frontend_health": "passed",
    "backend_health": "passed",
    "ai_health": "passed",
    "compose_status": "passed",
    "trino_runtime": "skipped",
}
PY
then
  record_pass "diagnose writes a passed, secret-free record"
else
  record_fail "diagnose writes a passed, secret-free record"
fi

if ! rg -q 'asklake-ec2\.pem|deploy/\.env|@' "$success_record"; then
  record_pass "diagnostic record omits SSH and environment secrets"
else
  record_fail "diagnostic record omits SSH and environment secrets"
fi

failure_record="$TEMP_DIR/failure.json"
set +e
ASKLAKE_FAKE_CURL_FAILURE=backend run_diagnose "$failure_record" env
failure_status=$?
set -e
if [[ "$failure_status" -ne 0 ]] && "$PYTHON_BIN" - "$failure_record" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
statuses = {item["name"]: item["status"] for item in record["checks"]}
assert record["overallStatus"] == "failed"
assert statuses["backend_health"] == "failed"
assert statuses["compose_status"] == "passed"
PY
then
  record_pass "diagnose preserves later observations after backend health fails"
else
  record_fail "diagnose preserves later observations after backend health fails"
fi

stopped_record="$TEMP_DIR/stopped.json"
set +e
ASKLAKE_FAKE_INSTANCE_STATE=stopped \
  ASKLAKE_TEST_SSH_BIN="$TEMP_DIR/missing-ssh" \
  run_diagnose "$stopped_record" env
stopped_status=$?
set -e
if [[ "$stopped_status" -ne 0 ]] && "$PYTHON_BIN" - "$stopped_record" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
statuses = {item["name"]: item["status"] for item in record["checks"]}
assert record["overallStatus"] == "failed"
assert statuses["ec2_running"] == "failed"
assert statuses["frontend_health"] == "skipped"
assert statuses["compose_status"] == "skipped"
PY
then
  record_pass "diagnose writes a bounded record when EC2 is stopped without SSH"
else
  record_fail "diagnose writes a bounded record when EC2 is stopped without SSH"
fi

if ! "$PYTHON_BIN" "$ROOT_DIR/scripts/write-deploy-diagnostic.py" \
  --output "$TEMP_DIR/invalid.json" \
  --command diagnose \
  --app-url 'https://user:secret@example.test' \
  --check ec2_running=passed >/dev/null 2>&1; then
  record_pass "diagnostic writer rejects credential-bearing URLs"
else
  record_fail "diagnostic writer rejects credential-bearing URLs"
fi

printf 'deploy diagnostic regression summary: %s passed, %s failed\n' "$pass_count" "$fail_count"
[[ "$fail_count" -eq 0 ]]
