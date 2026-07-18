#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

pass_count=0
fail_count=0

record_pass() {
  printf 'ok - %s\n' "$1"
  pass_count=$((pass_count + 1))
}

record_fail() {
  printf 'not ok - %s\n' "$1" >&2
  fail_count=$((fail_count + 1))
}

make_fake_docker() {
  cat >"$TEMP_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${ASKLAKE_DOCKER_CALL_LOG:?}"
if [[ "${ASKLAKE_FAIL_CHECK:-}" == "backend_image" && "$1" == "build" && "$*" == *"asklake-backend-deploy-check"* ]]; then
  exit 1
fi
EOF
  chmod +x "$TEMP_DIR/docker"
}

make_fake_node() {
  cat >"$TEMP_DIR/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${ASKLAKE_FASTAPI_PYTHON:-}" == /* ]] || {
  echo "ASKLAKE_FASTAPI_PYTHON must be an absolute path" >&2
  exit 1
}
printf 'node:%s\n' "$*" >>"${ASKLAKE_DOCKER_CALL_LOG:?}"
EOF
  chmod +x "$TEMP_DIR/node"
}

make_fake_npm() {
  cat >"$TEMP_DIR/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm:%s\n' "$*" >>"${ASKLAKE_DOCKER_CALL_LOG:?}"
EOF
  chmod +x "$TEMP_DIR/npm"
}

make_fake_docker
make_fake_node
make_fake_npm

record_path="$TEMP_DIR/record.json"
call_log="$TEMP_DIR/docker-calls.log"
if ASKLAKE_DOCKER_BIN="$TEMP_DIR/docker" \
  ASKLAKE_NODE_BIN="$TEMP_DIR/node" \
  ASKLAKE_NPM_BIN="$TEMP_DIR/npm" \
  ASKLAKE_SKIP_BACKEND_PYTHON_DEPENDENCIES=true \
  ASKLAKE_DOCKER_CALL_LOG="$call_log" \
  ASKLAKE_RELEASE_RECORD_PATH="$record_path" \
  ASKLAKE_RELEASE_RECORD_SOURCE="regression" \
  GITHUB_SHA="release-record-test-sha" \
  bash "$ROOT_DIR/scripts/verify-deploy-readiness.sh" >/dev/null \
  && python3 - "$record_path" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["schemaVersion"] == 1
assert record["revision"] == "release-record-test-sha"
assert record["source"] == "regression"
assert record["overallStatus"] == "passed"
assert record["checks"] == [
    {"name": "compose_config", "status": "passed"},
    {"name": "backend_image", "status": "passed"},
    {"name": "backend_dependencies", "status": "passed"},
    {"name": "backend_python_dependencies", "status": "skipped"},
    {"name": "backend_runtime_contract", "status": "passed"},
    {"name": "frontend_image", "status": "passed"},
]
PY
then
  record_pass 'readiness writes a passed release record after all checks'
else
  record_fail 'readiness writes a passed release record after all checks'
fi

failed_record_path="$TEMP_DIR/failed-record.json"
if ASKLAKE_DOCKER_BIN="$TEMP_DIR/docker" \
  ASKLAKE_NODE_BIN="$TEMP_DIR/node" \
  ASKLAKE_NPM_BIN="$TEMP_DIR/npm" \
  ASKLAKE_SKIP_BACKEND_PYTHON_DEPENDENCIES=true \
  ASKLAKE_DOCKER_CALL_LOG="$call_log" \
  ASKLAKE_RELEASE_RECORD_PATH="$failed_record_path" \
  ASKLAKE_FAIL_CHECK="backend_image" \
  GITHUB_SHA="release-record-failure-sha" \
  bash "$ROOT_DIR/scripts/verify-deploy-readiness.sh" >/dev/null 2>&1
then
  record_fail 'readiness exits non-zero after an image check fails'
elif python3 - "$failed_record_path" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["overallStatus"] == "failed"
assert {check["name"]: check["status"] for check in record["checks"]}["backend_image"] == "failed"
PY
then
  record_pass 'readiness records an image failure before exiting'
else
  record_fail 'readiness records an image failure before exiting'
fi

unwritable_parent="$TEMP_DIR/not-a-directory"
: >"$unwritable_parent"
if ASKLAKE_DOCKER_BIN="$TEMP_DIR/docker" \
  ASKLAKE_NODE_BIN="$TEMP_DIR/node" \
  ASKLAKE_NPM_BIN="$TEMP_DIR/npm" \
  ASKLAKE_SKIP_BACKEND_PYTHON_DEPENDENCIES=true \
  ASKLAKE_DOCKER_CALL_LOG="$call_log" \
  ASKLAKE_RELEASE_RECORD_PATH="$unwritable_parent/record.json" \
  GITHUB_SHA="release-record-write-failure-sha" \
  bash "$ROOT_DIR/scripts/verify-deploy-readiness.sh" >/dev/null 2>&1
then
  record_fail 'readiness fails when it cannot write the release record'
else
  record_pass 'readiness fails when it cannot write the release record'
fi

if python3 "$ROOT_DIR/scripts/write-release-record.py" \
  --output "$TEMP_DIR/invalid.json" \
  --check 'compose_config=unknown' >/dev/null 2>&1
then
  record_fail 'release record rejects an unknown check status'
else
  record_pass 'release record rejects an unknown check status'
fi

printf 'deploy readiness regression summary: %s passed, %s failed\n' \
  "$pass_count" "$fail_count"
(( fail_count == 0 ))
