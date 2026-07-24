#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

AWS_BIN="${ASKLAKE_AWS_BIN:-aws}"
CURL_BIN="${ASKLAKE_CURL_BIN:-curl}"
PYTHON_BIN="${ASKLAKE_PYTHON_BIN:-python3}"
SSH_BIN="${ASKLAKE_SSH_BIN:-ssh}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
EC2_INSTANCE_ID="${ASKLAKE_EC2_INSTANCE_ID:-${EC2_INSTANCE_ID:-}}"
EC2_HOST="${ASKLAKE_EC2_HOST:-${EC2_HOST:-}}"
EC2_USER="${ASKLAKE_EC2_USER:-ec2-user}"
SSH_KEY="${ASKLAKE_SSH_KEY:-$HOME/.ssh/asklake-ec2.pem}"
DEPLOY_PATH="${ASKLAKE_DEPLOY_PATH:-/opt/asklake}"
DEPLOY_BRANCH="${ASKLAKE_DEPLOY_BRANCH:-dev}"
APP_URL="${ASKLAKE_APP_URL:-}"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env}"
COMPOSE_PROJECT_NAME="${ASKLAKE_COMPOSE_PROJECT_NAME:-}"
HEALTH_PATH="${ASKLAKE_HEALTH_PATH:-/api/health}"
AI_HEALTH_PATH="${ASKLAKE_AI_HEALTH_PATH:-/api/health/ai}"
HEALTH_RETRIES="${ASKLAKE_HEALTH_RETRIES:-18}"
HEALTH_RETRY_DELAY="${ASKLAKE_HEALTH_RETRY_DELAY:-5}"
DEPLOY_DIAGNOSTIC_PATH="${ASKLAKE_DEPLOY_DIAGNOSTIC_PATH:-${TMPDIR:-/tmp}/asklake-deploy-diagnostic.json}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -i "$SSH_KEY")

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME <command>

Commands:
  status     Show EC2 state, public address, and remote compose status when reachable.
  start      Start the EC2 instance, wait for SSH, then ensure Docker Compose is up.
  stop       Stop Docker Compose when reachable, then stop the EC2 instance.
  deploy     Start if needed, pull the deploy branch, rebuild Compose, and health check.
  restart    Recreate the Compose stack on the running EC2 instance.
  health     Check HTTPS/API health and remote Compose status.
  diagnose   Record read-only deployment diagnostics as JSON.
  logs       Tail remote Compose logs. Use ASKLAKE_LOG_SERVICE and ASKLAKE_LOG_LINES.
  ssh        Open an SSH shell to the EC2 instance.

Required:
  ASKLAKE_EC2_INSTANCE_ID  EC2 instance id, for example i-xxxxxxxxxxxxxxxxx.
  ASKLAKE_COMPOSE_PROJECT_NAME Exact existing Compose project name.

Optional:
  AWS_REGION               Default: ap-northeast-2
  ASKLAKE_EC2_HOST         Overrides host lookup, useful for Elastic IP or sslip.io.
  ASKLAKE_EC2_USER         Default: ec2-user
  ASKLAKE_SSH_KEY          Default: \$HOME/.ssh/asklake-ec2.pem
  ASKLAKE_DEPLOY_PATH      Default: /opt/asklake
  ASKLAKE_DEPLOY_BRANCH    Must be dev (default: dev)
  ASKLAKE_APP_URL          Default: https://<resolved-host>, or http://<ipv4-host>
  ASKLAKE_HEALTH_RETRIES   Default: 18
  ASKLAKE_HEALTH_RETRY_DELAY Default: 5 seconds
  ASKLAKE_DEPLOY_DIAGNOSTIC_PATH Default: \${TMPDIR:-/tmp}/asklake-deploy-diagnostic.json
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_instance_id() {
  [[ -n "$EC2_INSTANCE_ID" ]] || die "ASKLAKE_EC2_INSTANCE_ID is required"
}

require_deploy_branch() {
  [[ "$DEPLOY_BRANCH" == "dev" ]] \
    || die "EC2 deployment source branch must be dev"
}

instance_field() {
  local query="$1"
  "$AWS_BIN" ec2 describe-instances \
    --region "$AWS_REGION" \
    --instance-ids "$EC2_INSTANCE_ID" \
    --query "$query" \
    --output text
}

instance_state() {
  instance_field 'Reservations[0].Instances[0].State.Name'
}

resolve_host() {
  if [[ -n "$EC2_HOST" ]]; then
    printf '%s\n' "$EC2_HOST"
    return
  fi

  local host
  host="$(instance_field 'Reservations[0].Instances[0].PublicIpAddress')"
  [[ "$host" != "None" && -n "$host" ]] || die "could not resolve public host; set ASKLAKE_EC2_HOST"
  printf '%s\n' "$host"
}

resolve_app_url() {
  if [[ -n "$APP_URL" ]]; then
    printf '%s\n' "$APP_URL"
    return
  fi

  local host
  host="$(resolve_host)"
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'http://%s\n' "$host"
  else
    printf 'https://%s\n' "$host"
  fi
}

ssh_run() {
  local host
  host="$(resolve_host)"
  if ! command -v "$SSH_BIN" >/dev/null 2>&1; then
    printf 'error: missing command: %s\n' "$SSH_BIN" >&2
    return 127
  fi
  "$SSH_BIN" "${SSH_OPTS[@]}" "$EC2_USER@$host" "$@"
}

compose_cmd() {
  [[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || \
    die "ASKLAKE_COMPOSE_PROJECT_NAME must be a lowercase Compose project name"
  printf 'docker compose --project-name %q --env-file %q -f %q' \
    "$COMPOSE_PROJECT_NAME" "$COMPOSE_ENV_FILE" "$COMPOSE_FILE"
}

remote_compose() {
  local command="$1"
  ssh_run "cd '$DEPLOY_PATH' && $(compose_cmd) $command"
}

remote_deploy_preflight() {
  ssh_run "cd '$DEPLOY_PATH' && bash scripts/verify-deploy-env.sh '$COMPOSE_ENV_FILE' '$COMPOSE_FILE'"
}

verify_remote_dev_checkout() {
  ssh_run "cd '$DEPLOY_PATH' && git fetch origin dev && git symbolic-ref --short HEAD | grep -Fxq dev && if git status --porcelain --untracked-files=all | grep -q .; then echo 'error: remote deploy checkout is dirty' >&2; exit 1; fi && git merge-base --is-ancestor HEAD origin/dev && git merge-base --is-ancestor origin/dev HEAD && git rev-parse HEAD"
}

update_remote_dev_checkout() {
  ssh_run "cd '$DEPLOY_PATH' && if git status --porcelain --untracked-files=all | grep -q .; then echo 'error: remote deploy checkout is dirty' >&2; exit 1; fi && git fetch origin dev && git checkout dev && git pull --ff-only origin dev"
  verify_remote_dev_checkout
}

airflow_execution_token_hash() {
  local service="$1"
  local environment_key="$2"

  remote_compose "exec -T $service sh -lc 'token=\${${environment_key}:-}; test -n \"\$token\"; printf \"%s\" \"\$token\" | sha256sum | awk \"{print \$1}\"'"
}

verify_airflow_execution_token_parity() {
  local backend_hash
  local scheduler_hash

  backend_hash="$(airflow_execution_token_hash backend AIRFLOW_EXECUTION_API_TOKEN)" \
    || die "backend AIRFLOW_EXECUTION_API_TOKEN is missing"
  scheduler_hash="$(airflow_execution_token_hash airflow-scheduler ASKLAKE_EXECUTION_API_TOKEN)" \
    || die "airflow-scheduler ASKLAKE_EXECUTION_API_TOKEN is missing"

  [[ "$backend_hash" == "$scheduler_hash" ]] \
    || die "Airflow execution token drift detected between backend and airflow-scheduler"

  printf 'Airflow execution token parity verified.\n'
}

recreate_airflow_execution_control_plane() {
  remote_compose 'up -d --build --force-recreate backend airflow-apiserver airflow-scheduler airflow-dag-processor'
  verify_airflow_execution_token_parity
}

remote_trino_enabled() {
  remote_compose 'config --format json' | "$PYTHON_BIN" -c '
import json
import sys

try:
    enabled = json.load(sys.stdin)["services"]["backend"]["environment"].get("TRINO_ENABLED")
except (AttributeError, KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
print("true" if str(enabled).strip().lower() == "true" else "false")
'
}

remote_clickhouse_enabled() {
  remote_compose 'config --format json' | "$PYTHON_BIN" -c '
import json
import sys

try:
    enabled = json.load(sys.stdin)["services"]["backend"]["environment"].get("CLICKHOUSE_CONTINUOUS_JOIN_ENABLED")
except (AttributeError, KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
print("true" if str(enabled).strip().lower() == "true" else "false")
'
}

remote_clickhouse_v2_enabled() {
  remote_compose 'config --format json' | "$PYTHON_BIN" -c '
import json
import sys

try:
    enabled = json.load(sys.stdin)["services"]["backend"]["environment"].get("CLICKHOUSE_REALTIME_V2_ENABLED")
except (AttributeError, KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
print("true" if str(enabled).strip().lower() == "true" else "false")
'
}

wait_for_ssh() {
  local host
  host="$(resolve_host)"

  printf 'Waiting for SSH on %s...\n' "$host"
  for _ in $(seq 1 60); do
    if "$SSH_BIN" "${SSH_OPTS[@]}" -o ConnectTimeout=5 "$EC2_USER@$host" 'true' >/dev/null 2>&1; then
      printf 'SSH is ready.\n'
      return
    fi
    sleep 5
  done

  die "SSH did not become ready"
}

ensure_started() {
  local state
  state="$(instance_state)"

  case "$state" in
    running)
      printf 'EC2 instance is already running.\n'
      ;;
    stopped)
      printf 'Starting EC2 instance %s...\n' "$EC2_INSTANCE_ID"
      "$AWS_BIN" ec2 start-instances --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" >/dev/null
      "$AWS_BIN" ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
      ;;
    pending)
      printf 'EC2 instance is pending; waiting...\n'
      "$AWS_BIN" ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
      ;;
    *)
      die "cannot start from EC2 state: $state"
      ;;
  esac

  wait_for_ssh
}

health_payload_ready() {
  "$PYTHON_BIN" -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
    raise SystemExit(1)

ready = (
    isinstance(payload, dict)
    and payload.get("ok") is True
    and payload.get("statusCode", 200) == 200
    and isinstance(payload.get("database"), dict)
    and payload["database"].get("ok") is True
)
raise SystemExit(0 if ready else 1)
'
}

ai_health_payload_ready() {
  "$PYTHON_BIN" -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
    raise SystemExit(1)

raise SystemExit(0 if isinstance(payload, dict) and payload.get("ok") is True else 1)
'
}

health_check() {
  local url
  local health_payload

  need_command "$PYTHON_BIN"
  url="$(resolve_app_url)"

  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    printf 'Checking frontend: %s (attempt %s/%s)\n' "$url" "$attempt" "$HEALTH_RETRIES"
    if "$CURL_BIN" -fsSI --location --max-time 20 "$url" >/dev/null; then
      printf 'Checking backend: %s%s (attempt %s/%s)\n' "$url" "$HEALTH_PATH" "$attempt" "$HEALTH_RETRIES"
      if health_payload="$("$CURL_BIN" -fsS --location --max-time 20 "${url}${HEALTH_PATH}")"; then
        if printf '%s' "$health_payload" | health_payload_ready; then
          printf 'Backend health is deployment-ready.\n'
          printf 'Checking AI gateway: %s%s (attempt %s/%s)\n' "$url" "$AI_HEALTH_PATH" "$attempt" "$HEALTH_RETRIES"
          if ai_health_payload="$("$CURL_BIN" -fsS --location --max-time 20 "${url}${AI_HEALTH_PATH}")"; then
            if printf '%s' "$ai_health_payload" | ai_health_payload_ready; then
              printf 'AI gateway health is deployment-ready.\n'
              return
            fi
          fi
          printf 'AI gateway health is not ready after redirect resolution.\n' >&2
        else
          printf 'Backend health JSON is not ready after redirect resolution; expected .ok=true and .database.ok=true with .statusCode=200.\n' >&2
        fi
      else
        printf 'Backend health request failed after redirect resolution.\n' >&2
      fi
    else
      printf 'Frontend reachability or redirect check failed.\n' >&2
    fi

    if [[ "$attempt" -lt "$HEALTH_RETRIES" ]]; then
      sleep "$HEALTH_RETRY_DELAY"
    fi
  done

  die "health check failed after $HEALTH_RETRIES attempts"
}

show_status() {
  local state
  state="$(instance_state)"

  printf 'EC2 instance: %s\n' "$EC2_INSTANCE_ID"
  printf 'Region: %s\n' "$AWS_REGION"
  printf 'State: %s\n' "$state"
  printf 'Host: %s\n' "$(resolve_host)"

  if [[ "$state" != "running" ]]; then
    printf 'Remote Compose status skipped: EC2 is %s.\n' "$state"
    return
  fi

  if ssh_run 'true' >/dev/null 2>&1; then
    remote_compose 'ps'
  else
    printf 'Remote Compose status skipped: SSH is not reachable.\n'
  fi
}

bootstrap_trino_dependencies() {
  if [[ "$(remote_trino_enabled)" != "true" ]]; then
    printf 'Trino is disabled; removing any stale profiled runtime containers.\n'
    remote_compose 'rm -sf trino-result-collector trino-result-cleanup trino trino-postgres-bootstrap'
    return
  fi
  remote_compose 'up -d postgres'
  remote_compose 'run --rm trino-postgres-bootstrap'
}

verify_trino_runtime() {
  local attempt
  if [[ "$(remote_trino_enabled)" != "true" ]]; then
    printf 'Trino is disabled; runtime readiness check skipped.\n'
    return
  fi
  for attempt in $(seq 1 12); do
    if remote_compose 'exec -T backend python scripts/verify-trino-production-readiness.py'; then
      return
    fi
    if [[ "$attempt" -lt 12 ]]; then
      printf 'Trino readiness is not ready yet (attempt %s/12).\n' "$attempt"
      sleep 5
    fi
  done
  die "Trino production readiness failed"
}

prepare_clickhouse_runtime() {
  if [[ "$(remote_clickhouse_enabled)" != "true" ]]; then
    printf 'ClickHouse Continuous JOIN is disabled; removing any stale profiled runtime container.\n'
    remote_compose 'rm -sf clickhouse'
    return
  fi
  remote_compose 'up -d redpanda clickhouse'
}

bootstrap_metadata_schema() {
  remote_compose 'up -d --wait postgres'
  remote_compose 'run --rm --no-deps --build backend python scripts/migrate-metadata-schema.py'
  remote_compose 'run --rm --no-deps --build backend python -m alembic upgrade head'
}

prepare_clickhouse_v2_runtime() {
  if [[ "$(remote_clickhouse_v2_enabled)" != "true" ]]; then
    printf 'ClickHouse Realtime V2 is disabled; removing stale V2 runtime containers.\n'
    remote_compose 'rm -sf kafka-connect-v2 clickhouse-v2 clickhouse-keeper-v2'
    return
  fi
  remote_compose 'up -d --wait redpanda clickhouse-keeper-v2 clickhouse-v2 kafka-connect-v2'
}

verify_clickhouse_runtime() {
  local attempt
  if [[ "$(remote_clickhouse_enabled)" != "true" ]]; then
    printf 'ClickHouse Continuous JOIN is disabled; runtime readiness check skipped.\n'
    return
  fi
  for attempt in $(seq 1 12); do
    if remote_compose 'exec -T backend python -c "from app.services.clickhouse_client import ClickHouseClient; client = ClickHouseClient(); assert client.ping(); client.close()"'; then
      return
    fi
    if [[ "$attempt" -lt 12 ]]; then
      printf 'ClickHouse readiness is not ready yet (attempt %s/12).\n' "$attempt"
      sleep 5
    fi
  done
  die "ClickHouse production readiness failed"
}

verify_clickhouse_v2_runtime() {
  local attempt
  if [[ "$(remote_clickhouse_v2_enabled)" != "true" ]]; then
    printf 'ClickHouse Realtime V2 is disabled; runtime readiness check skipped.\n'
    return
  fi
  for attempt in $(seq 1 12); do
    if remote_compose 'exec -T backend python -c "from app.realtime.application.ingest_service import RealtimeIngestService; from app.services.clickhouse_client import ClickHouseClient; client = ClickHouseClient.realtime_v2_reader(); assert client.ping(); client.close(); assert RealtimeIngestService().probe().runtime_ready"'; then
      return
    fi
    if [[ "$attempt" -lt 12 ]]; then
      printf 'ClickHouse Realtime V2 readiness is not ready yet (attempt %s/12).\n' "$attempt"
      sleep 5
    fi
  done
  die "ClickHouse Realtime V2 production readiness failed"
}

DIAGNOSTIC_CHECKS=()
DIAGNOSTIC_FAILED=false

record_diagnostic_check() {
  local name="$1"
  local check_status="$2"

  DIAGNOSTIC_CHECKS+=("${name}=${check_status}")
  if [[ "$check_status" == "failed" ]]; then
    DIAGNOSTIC_FAILED=true
  fi
}

run_diagnostic_check() {
  local name="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    record_diagnostic_check "$name" passed
  else
    record_diagnostic_check "$name" failed
  fi
}

diagnostic_backend_health() {
  local url="$1"
  local health_payload

  health_payload="$("$CURL_BIN" -fsSL --max-time 20 "${url}${HEALTH_PATH}")" || return 1
  printf '%s' "$health_payload" | health_payload_ready
}

diagnostic_ai_health() {
  local url="$1"
  local health_payload

  health_payload="$("$CURL_BIN" -fsSL --max-time 20 "${url}${AI_HEALTH_PATH}")" || return 1
  printf '%s' "$health_payload" | ai_health_payload_ready
}

diagnose_trino_runtime() {
  local enabled

  if ! enabled="$(remote_trino_enabled 2>/dev/null)"; then
    record_diagnostic_check trino_runtime failed
  elif [[ "$enabled" != "true" ]]; then
    record_diagnostic_check trino_runtime skipped
  else
    run_diagnostic_check trino_runtime \
      remote_compose 'exec -T backend python scripts/verify-trino-production-readiness.py'
  fi
}

diagnose_clickhouse_runtime() {
  local enabled

  if ! enabled="$(remote_clickhouse_enabled 2>/dev/null)"; then
    record_diagnostic_check clickhouse_runtime failed
  elif [[ "$enabled" != "true" ]]; then
    record_diagnostic_check clickhouse_runtime skipped
  else
    run_diagnostic_check clickhouse_runtime \
      remote_compose 'exec -T backend python -c "from app.services.clickhouse_client import ClickHouseClient; client = ClickHouseClient(); assert client.ping(); client.close()"'
  fi
}

write_deploy_diagnostic() {
  local app_url="$1"
  local instance_state_value="$2"
  local arguments=(
    --output "$DEPLOY_DIAGNOSTIC_PATH"
    --command diagnose
  )
  local check

  if [[ -n "$app_url" ]]; then
    arguments+=(--app-url "$app_url")
  fi
  if [[ -n "$instance_state_value" ]]; then
    arguments+=(--instance-state "$instance_state_value")
  fi
  for check in "${DIAGNOSTIC_CHECKS[@]}"; do
    arguments+=(--check "$check")
  done

  "$PYTHON_BIN" scripts/write-deploy-diagnostic.py "${arguments[@]}"
}

diagnose_stack() {
  local state=""
  local url=""

  DIAGNOSTIC_CHECKS=()
  DIAGNOSTIC_FAILED=false

  if state="$(instance_state 2>/dev/null)"; then
    if [[ "$state" == "running" ]]; then
      record_diagnostic_check ec2_running passed
    else
      record_diagnostic_check ec2_running failed
    fi
  else
    record_diagnostic_check ec2_running failed
  fi

  if url="$(resolve_app_url 2>/dev/null)"; then
    record_diagnostic_check canonical_url passed
  else
    record_diagnostic_check canonical_url failed
  fi

  if [[ "$state" != "running" ]]; then
    record_diagnostic_check deploy_env_preflight skipped
    record_diagnostic_check frontend_health skipped
    record_diagnostic_check backend_health skipped
    record_diagnostic_check ai_health skipped
    record_diagnostic_check compose_status skipped
    record_diagnostic_check trino_runtime skipped
    record_diagnostic_check clickhouse_runtime skipped
  else
    run_diagnostic_check deploy_env_preflight remote_deploy_preflight
    if [[ -n "$url" ]]; then
      run_diagnostic_check frontend_health "$CURL_BIN" -fsSIL --max-time 20 "$url"
      run_diagnostic_check backend_health diagnostic_backend_health "$url"
      run_diagnostic_check ai_health diagnostic_ai_health "$url"
    else
      record_diagnostic_check frontend_health skipped
      record_diagnostic_check backend_health skipped
      record_diagnostic_check ai_health skipped
    fi
    run_diagnostic_check compose_status remote_compose 'ps --format json'
    diagnose_trino_runtime
    diagnose_clickhouse_runtime
  fi

  if ! write_deploy_diagnostic "$url" "$state"; then
    die "could not write deploy diagnostic: $DEPLOY_DIAGNOSTIC_PATH"
  fi

  printf 'Deploy diagnostic record: %s\n' "$DEPLOY_DIAGNOSTIC_PATH"
  [[ "$DIAGNOSTIC_FAILED" == "false" ]] || return 1
}

start_stack() {
  require_deploy_branch
  ensure_started
  verify_remote_dev_checkout
  remote_deploy_preflight
  bootstrap_metadata_schema
  bootstrap_trino_dependencies
  prepare_clickhouse_runtime
  prepare_clickhouse_v2_runtime
  remote_compose 'up -d'
  recreate_airflow_execution_control_plane
  health_check
  verify_trino_runtime
  verify_clickhouse_runtime
  verify_clickhouse_v2_runtime
  remote_compose 'ps'
}

stop_stack() {
  local state
  state="$(instance_state)"

  if [[ "$state" == "running" ]]; then
    if ssh_run 'true' >/dev/null 2>&1; then
      remote_compose 'stop'
    else
      printf 'SSH is not reachable; skipping Compose stop.\n'
    fi
  else
    printf 'EC2 instance is %s; skipping Compose stop.\n' "$state"
  fi

  if [[ "$state" != "stopped" ]]; then
    printf 'Stopping EC2 instance %s...\n' "$EC2_INSTANCE_ID"
    "$AWS_BIN" ec2 stop-instances --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" >/dev/null
    "$AWS_BIN" ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
  fi

  printf 'EC2 instance is stopped.\n'
}

deploy_stack() {
  require_deploy_branch
  ensure_started
  update_remote_dev_checkout
  remote_deploy_preflight
  bootstrap_metadata_schema
  bootstrap_trino_dependencies
  prepare_clickhouse_runtime
  prepare_clickhouse_v2_runtime
  remote_compose 'up -d --build'
  recreate_airflow_execution_control_plane
  health_check
  verify_trino_runtime
  verify_clickhouse_runtime
  verify_clickhouse_v2_runtime
  remote_compose 'ps'
}

restart_stack() {
  require_deploy_branch
  ensure_started
  verify_remote_dev_checkout
  remote_deploy_preflight
  bootstrap_metadata_schema
  bootstrap_trino_dependencies
  prepare_clickhouse_runtime
  prepare_clickhouse_v2_runtime
  remote_compose 'up -d --build'
  recreate_airflow_execution_control_plane
  health_check
  verify_trino_runtime
  verify_clickhouse_runtime
  verify_clickhouse_v2_runtime
  remote_compose 'ps'
}

tail_logs() {
  local service="${ASKLAKE_LOG_SERVICE:-}"
  local lines="${ASKLAKE_LOG_LINES:-120}"

  if [[ -n "$service" ]]; then
    remote_compose "logs --tail=$lines '$service'"
  else
    remote_compose "logs --tail=$lines"
  fi
}

open_ssh() {
  local host
  host="$(resolve_host)"
  "$SSH_BIN" "${SSH_OPTS[@]}" "$EC2_USER@$host"
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || {
    usage
    exit 2
  }

  case "$command" in
    -h|--help|help)
      usage
      exit 0
      ;;
  esac

  case "$command" in
    start|deploy|restart) require_deploy_branch ;;
  esac

  need_command "$AWS_BIN"
  need_command "$PYTHON_BIN"
  require_instance_id

  case "$command" in
    status) show_status ;;
    start) start_stack ;;
    stop) stop_stack ;;
    deploy) deploy_stack ;;
    restart) restart_stack ;;
    health) health_check && remote_compose 'ps' ;;
    diagnose) diagnose_stack ;;
    logs) tail_logs ;;
    ssh) open_ssh ;;
    *)
      usage
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
