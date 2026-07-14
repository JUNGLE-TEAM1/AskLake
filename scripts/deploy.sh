#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

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
HEALTH_PATH="${ASKLAKE_HEALTH_PATH:-/api/health}"
HEALTH_RETRIES="${ASKLAKE_HEALTH_RETRIES:-18}"
HEALTH_RETRY_DELAY="${ASKLAKE_HEALTH_RETRY_DELAY:-5}"
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
  logs       Tail remote Compose logs. Use ASKLAKE_LOG_SERVICE and ASKLAKE_LOG_LINES.
  ssh        Open an SSH shell to the EC2 instance.

Required:
  ASKLAKE_EC2_INSTANCE_ID  EC2 instance id, for example i-xxxxxxxxxxxxxxxxx.

Optional:
  AWS_REGION               Default: ap-northeast-2
  ASKLAKE_EC2_HOST         Overrides host lookup, useful for Elastic IP or sslip.io.
  ASKLAKE_EC2_USER         Default: ec2-user
  ASKLAKE_SSH_KEY          Default: \$HOME/.ssh/asklake-ec2.pem
  ASKLAKE_DEPLOY_PATH      Default: /opt/asklake
  ASKLAKE_DEPLOY_BRANCH    Default: dev
  ASKLAKE_APP_URL          Default: https://<resolved-host>, or http://<ipv4-host>
  ASKLAKE_HEALTH_RETRIES   Default: 18
  ASKLAKE_HEALTH_RETRY_DELAY Default: 5 seconds
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

instance_field() {
  local query="$1"
  aws ec2 describe-instances \
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
  ssh "${SSH_OPTS[@]}" "$EC2_USER@$host" "$@"
}

compose_cmd() {
  printf 'docker compose --env-file %q -f %q' "$COMPOSE_ENV_FILE" "$COMPOSE_FILE"
}

remote_compose() {
  local command="$1"
  ssh_run "cd '$DEPLOY_PATH' && $(compose_cmd) $command"
}

remote_deploy_preflight() {
  ssh_run "cd '$DEPLOY_PATH' && bash scripts/verify-deploy-env.sh '$COMPOSE_ENV_FILE' '$COMPOSE_FILE'"
}

remote_trino_enabled() {
  remote_compose 'config --format json' | python3 -c '
import json
import sys

try:
    enabled = json.load(sys.stdin)["services"]["backend"]["environment"].get("TRINO_ENABLED")
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
    if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=5 "$EC2_USER@$host" 'true' >/dev/null 2>&1; then
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
      aws ec2 start-instances --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" >/dev/null
      aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
      ;;
    pending)
      printf 'EC2 instance is pending; waiting...\n'
      aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
      ;;
    *)
      die "cannot start from EC2 state: $state"
      ;;
  esac

  wait_for_ssh
}

health_payload_ready() {
  python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
    raise SystemExit(1)

ready = (
    isinstance(payload, dict)
    and payload.get("ok") is True
    and isinstance(payload.get("database"), dict)
    and payload["database"].get("ok") is True
)
raise SystemExit(0 if ready else 1)
'
}

health_check() {
  local url
  local health_payload

  need_command python3
  url="$(resolve_app_url)"

  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    printf 'Checking frontend: %s (attempt %s/%s)\n' "$url" "$attempt" "$HEALTH_RETRIES"
    if curl -fsSI --max-time 20 "$url" >/dev/null; then
      printf 'Checking backend: %s%s (attempt %s/%s)\n' "$url" "$HEALTH_PATH" "$attempt" "$HEALTH_RETRIES"
      if health_payload="$(curl -fsS --max-time 20 "${url}${HEALTH_PATH}")"; then
        if printf '%s' "$health_payload" | health_payload_ready; then
          printf 'Backend health is deployment-ready.\n'
          return
        fi
        printf 'Backend health is not ready; expected JSON booleans .ok=true and .database.ok=true.\n' >&2
      fi
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

start_stack() {
  ensure_started
  remote_deploy_preflight
  bootstrap_trino_dependencies
  remote_compose 'up -d'
  health_check
  verify_trino_runtime
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
    aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" >/dev/null
    aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID"
  fi

  printf 'EC2 instance is stopped.\n'
}

deploy_stack() {
  ensure_started
  ssh_run "cd '$DEPLOY_PATH' && git fetch origin '$DEPLOY_BRANCH' && git checkout '$DEPLOY_BRANCH' && git pull --ff-only origin '$DEPLOY_BRANCH'"
  remote_deploy_preflight
  bootstrap_trino_dependencies
  remote_compose 'up -d --build'
  health_check
  verify_trino_runtime
  remote_compose 'ps'
}

restart_stack() {
  ensure_started
  remote_deploy_preflight
  bootstrap_trino_dependencies
  remote_compose 'up -d --build'
  health_check
  verify_trino_runtime
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
  ssh "${SSH_OPTS[@]}" "$EC2_USER@$host"
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

  need_command aws
  need_command curl
  need_command python3
  need_command ssh
  require_instance_id

  case "$command" in
    status) show_status ;;
    start) start_stack ;;
    stop) stop_stack ;;
    deploy) deploy_stack ;;
    restart) restart_stack ;;
    health) health_check && remote_compose 'ps' ;;
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
