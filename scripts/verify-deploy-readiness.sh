#!/usr/bin/env bash
set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_BIN="${ASKLAKE_DOCKER_BIN:-docker}"
NODE_BIN="${ASKLAKE_NODE_BIN:-node}"
NPM_BIN="${ASKLAKE_NPM_BIN:-npm}"
PYTHON_BIN="${ASKLAKE_PYTHON_BIN:-python3}"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env.example}"
BACKEND_IMAGE="${ASKLAKE_VERIFY_BACKEND_IMAGE:-asklake-backend-deploy-check:local}"
FRONTEND_IMAGE="${ASKLAKE_VERIFY_FRONTEND_IMAGE:-asklake-frontend-deploy-check:local}"
RUNTIME_CONTRACT_SCRIPT="${ASKLAKE_RUNTIME_CONTRACT_SCRIPT:-backend/scripts/verify-production-spark-contract.mjs}"
BACKEND_VENV_DIR="${ASKLAKE_BACKEND_VENV_DIR:-backend/.venv}"
SKIP_BACKEND_PYTHON_DEPENDENCIES="${ASKLAKE_SKIP_BACKEND_PYTHON_DEPENDENCIES:-false}"
RELEASE_RECORD_PATH="${ASKLAKE_RELEASE_RECORD_PATH:-${TMPDIR:-/tmp}/asklake-deploy-readiness.json}"
RELEASE_RECORD_SOURCE="${ASKLAKE_RELEASE_RECORD_SOURCE:-local}"

cd "$ROOT_DIR"

if [[ "$BACKEND_VENV_DIR" != /* ]]; then
  BACKEND_VENV_DIR="$ROOT_DIR/$BACKEND_VENV_DIR"
fi
BACKEND_PYTHON="$BACKEND_VENV_DIR/bin/python"

need_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: missing command: $1" >&2
    exit 1
  }
}

checks=()
has_failure=false

run_check() {
  local name="$1"
  shift

  printf 'Running deploy readiness check: %s\n' "$name"
  if "$@"; then
    checks+=("${name}=passed")
  else
    checks+=("${name}=failed")
    has_failure=true
  fi
}

write_release_record() {
  local arguments=(
    --output "$RELEASE_RECORD_PATH"
    --source "$RELEASE_RECORD_SOURCE"
  )
  local check
  for check in "${checks[@]}"; do
    arguments+=(--check "$check")
  done
  "$PYTHON_BIN" scripts/write-release-record.py "${arguments[@]}"
}

prepare_backend_python_dependencies() {
  "$PYTHON_BIN" -m venv "$BACKEND_VENV_DIR"
  "$BACKEND_PYTHON" -m pip install --upgrade pip
  "$BACKEND_PYTHON" -m pip install -r backend/requirements.txt
}

need_command "$DOCKER_BIN"
need_command "$NODE_BIN"
need_command "$NPM_BIN"
need_command "$PYTHON_BIN"

run_check compose_config \
  "$DOCKER_BIN" compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" config --quiet
run_check backend_image \
  "$DOCKER_BIN" build -t "$BACKEND_IMAGE" backend
run_check backend_dependencies \
  "$NPM_BIN" --prefix backend ci --omit=dev
if [[ "$SKIP_BACKEND_PYTHON_DEPENDENCIES" == "true" ]]; then
  checks+=("backend_python_dependencies=skipped")
else
  run_check backend_python_dependencies prepare_backend_python_dependencies
fi
run_check backend_runtime_contract \
  env "ASKLAKE_FASTAPI_PYTHON=$BACKEND_PYTHON" \
    "$NODE_BIN" "$RUNTIME_CONTRACT_SCRIPT"
run_check frontend_image \
  "$DOCKER_BIN" build \
    --build-arg "VITE_API_BASE_URL=${VITE_API_BASE_URL:-http://localhost:8080}" \
    --build-arg "VITE_USE_MOCK_API=${VITE_USE_MOCK_API:-false}" \
    --build-arg "VITE_DASHBOARD_ASSISTANT_API_PATH=${VITE_DASHBOARD_ASSISTANT_API_PATH:-/api/dashboards/assistant}" \
    -t "$FRONTEND_IMAGE" frontend

if ! write_release_record; then
  echo "error: could not write deploy readiness record: $RELEASE_RECORD_PATH" >&2
  exit 1
fi

if [[ "$has_failure" == "true" ]]; then
  echo "error: deploy readiness checks failed; record: $RELEASE_RECORD_PATH" >&2
  exit 1
fi

echo "Deploy readiness checks passed; record: $RELEASE_RECORD_PATH"
