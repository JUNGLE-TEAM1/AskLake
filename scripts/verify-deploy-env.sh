#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-deploy/.env}"
COMPOSE_FILE="${2:-deploy/docker-compose.prod.yml}"

cd "$ROOT_DIR"

[[ -f "$ENV_FILE" ]] || {
  printf 'error: deployment env file not found: %s\n' "$ENV_FILE" >&2
  exit 1
}

[[ -f "$COMPOSE_FILE" ]] || {
  printf 'error: deployment Compose file not found: %s\n' "$COMPOSE_FILE" >&2
  exit 1
}

for required_command in docker python3; do
  command -v "$required_command" >/dev/null 2>&1 || {
    printf 'error: required preflight command not found: %s\n' "$required_command" >&2
    exit 1
  }
done

env_keys=()
env_values=()
env_key_counts=()

env_key_index() {
  local sought_key="$1"
  local index
  for index in "${!env_keys[@]}"; do
    if [[ "${env_keys[$index]}" == "$sought_key" ]]; then
      printf '%s' "$index"
      return 0
    fi
  done
  printf '%s' '-1'
}

env_value_for() {
  local sought_key="$1"
  local index
  index="$(env_key_index "$sought_key")"
  if (( index >= 0 )); then
    printf '%s' "${env_values[$index]}"
  fi
}

env_count_for() {
  local sought_key="$1"
  local index
  index="$(env_key_index "$sought_key")"
  if (( index >= 0 )); then
    printf '%s' "${env_key_counts[$index]}"
  else
    printf '%s' '0'
  fi
}

while IFS= read -r env_line || [[ -n "$env_line" ]]; do
  env_line="${env_line%$'\r'}"
  [[ "$env_line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$env_line" == *=* ]] || continue

  env_key="${env_line%%=*}"
  env_raw_value="${env_line#*=}"
  [[ "$env_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

  env_key_index_value="$(env_key_index "$env_key")"
  if (( env_key_index_value < 0 )); then
    env_keys+=("$env_key")
    env_values+=("")
    env_key_counts+=("1")
    env_key_index_value=$((${#env_keys[@]} - 1))
  else
    env_key_counts[$env_key_index_value]=$(( ${env_key_counts[$env_key_index_value]} + 1 ))
  fi
  if (( ${env_key_counts[$env_key_index_value]} == 1 )); then
    if (( ${#env_raw_value} >= 2 )); then
      env_first_character="${env_raw_value:0:1}"
      env_last_character="${env_raw_value: -1}"
      if [[ "$env_first_character" == "$env_last_character" \
        && ( "$env_first_character" == '"' || "$env_first_character" == "'" ) ]]; then
        env_raw_value="${env_raw_value:1:${#env_raw_value}-2}"
      fi
    fi
    env_values[$env_key_index_value]="$env_raw_value"
  fi
done < "$ENV_FILE"

is_blank() {
  [[ "$1" =~ ^[[:space:]]*$ ]]
}

required_keys=(
  AIRFLOW_API_AUTH_JWT_SECRET
  AIRFLOW_EXECUTION_API_TOKEN
  AIRFLOW_FERNET_KEY
  AIRFLOW_INTERNAL_TOKEN
  AIRFLOW_METADATA_DB_PASSWORD
  AIRFLOW_PASSWORD
  APP_DOMAIN
  APP_ENV
  ASKLAKE_HOST_DATA_DIR
  ASKLAKE_REPLAY_HOST_INPUT_DIR
  MINIO_ACCESS_KEY
  MINIO_ROOT_PASSWORD
  MINIO_ROOT_USER
  MINIO_SECRET_KEY
  MONGO_INITDB_ROOT_PASSWORD
  MONGO_INITDB_ROOT_USERNAME
  POSTGRES_DB
  POSTGRES_PASSWORD
  POSTGRES_USER
)

for key in "${required_keys[@]}"; do
  key_count="$(env_count_for "$key")"
  if (( key_count > 1 )); then
    printf 'error: %s must be defined exactly once in %s\n' "$key" "$ENV_FILE" >&2
    exit 1
  fi

  value="$(env_value_for "$key")"
  if is_blank "$value" || [[ "$value" == *replace-with-* || "$value" == *example.invalid* ]]; then
    printf 'error: %s must be set to a non-placeholder value in %s\n' "$key" "$ENV_FILE" >&2
    exit 1
  fi
done

airflow_fernet_key="$(env_value_for AIRFLOW_FERNET_KEY)"
if ! printf '%s' "$airflow_fernet_key" | python3 -c '
import base64
import binascii
import sys

encoded = sys.stdin.buffer.read()
try:
    decoded = base64.b64decode(encoded, altchars=b"-_", validate=True)
except (binascii.Error, ValueError):
    raise SystemExit(1)

valid = len(decoded) == 32 and base64.urlsafe_b64encode(decoded) == encoded
raise SystemExit(0 if valid else 1)
'; then
  printf 'error: AIRFLOW_FERNET_KEY must be canonical urlsafe base64 encoding of exactly 32 bytes\n' >&2
  exit 1
fi

raw_db_secret_keys=(
  AIRFLOW_METADATA_DB_PASSWORD
  POSTGRES_PASSWORD
)

for key in "${raw_db_secret_keys[@]}"; do
  value="$(env_value_for "$key")"
  if [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    printf 'error: %s must use only the unpadded base64url alphabet because Compose interpolates it into a connection URL\n' "$key" >&2
    exit 1
  fi
done

minio_root_user="$(env_value_for MINIO_ROOT_USER)"
minio_root_password="$(env_value_for MINIO_ROOT_PASSWORD)"
minio_access_key="$(env_value_for MINIO_ACCESS_KEY)"
minio_secret_key="$(env_value_for MINIO_SECRET_KEY)"
if [[ "$minio_access_key" == "$minio_root_user" || "$minio_secret_key" == "$minio_root_password" ]]; then
  printf 'error: MinIO application credentials must be distinct from MinIO root credentials\n' >&2
  exit 1
fi

app_env="$(env_value_for APP_ENV)"
[[ "$app_env" == "production" ]] || {
  printf 'error: APP_ENV must be production in %s\n' "$ENV_FILE" >&2
  exit 1
}

app_domain="$(env_value_for APP_DOMAIN)"
if [[ ! "$app_domain" =~ ^[A-Za-z0-9.-]+$ \
  || "$app_domain" == "localhost" \
  || "$app_domain" == "asklake.example.com" \
  || "$app_domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'error: APP_DOMAIN must be the deployed HTTPS DNS name, not a URL, placeholder, localhost, or bare IP\n' >&2
  exit 1
fi

require_host_directory() {
  local key="$1"
  local directory="$2"

  if [[ "$directory" != /* ]]; then
    printf 'error: %s must be an absolute host directory path\n' "$key" >&2
    exit 1
  fi
  if [[ ! -d "$directory" ]]; then
    printf 'error: %s directory does not exist: %s; create it and grant the deployment user access\n' "$key" "$directory" >&2
    exit 1
  fi
}

spark_host_data_dir="$(env_value_for ASKLAKE_HOST_DATA_DIR)"
spark_replay_input_dir="$(env_value_for ASKLAKE_REPLAY_HOST_INPUT_DIR)"

require_host_directory ASKLAKE_HOST_DATA_DIR "$spark_host_data_dir"
for spark_data_subdirectory in spark-ivy spark-output spark-runs samples review-text-models; do
  require_host_directory \
    "ASKLAKE_HOST_DATA_DIR/$spark_data_subdirectory" \
    "$spark_host_data_dir/$spark_data_subdirectory"
done
require_host_directory ASKLAKE_REPLAY_HOST_INPUT_DIR "$spark_replay_input_dir"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet

export ASKLAKE_PREFLIGHT_MINIO_ROOT_USER="$minio_root_user"
export ASKLAKE_PREFLIGHT_MINIO_ROOT_PASSWORD="$minio_root_password"
export ASKLAKE_PREFLIGHT_MINIO_ACCESS_KEY="$minio_access_key"
export ASKLAKE_PREFLIGHT_MINIO_SECRET_KEY="$minio_secret_key"

compose_wiring_status=0
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json \
  | python3 -c '
import json
import os
import sys

try:
    services = json.load(sys.stdin)["services"]
    backend = services["backend"]["environment"]
    minio = services["minio"]["environment"]
    minio_init = services["minio-init"]["environment"]
    spark_worker_service = services.get("spark-worker")
    spark_worker = spark_worker_service.get("environment", {}) if spark_worker_service else None
    expected = {
        "root_user": os.environ["ASKLAKE_PREFLIGHT_MINIO_ROOT_USER"],
        "root_password": os.environ["ASKLAKE_PREFLIGHT_MINIO_ROOT_PASSWORD"],
        "access_key": os.environ["ASKLAKE_PREFLIGHT_MINIO_ACCESS_KEY"],
        "secret_key": os.environ["ASKLAKE_PREFLIGHT_MINIO_SECRET_KEY"],
    }
    valid = all((
        minio.get("MINIO_ROOT_USER") == expected["root_user"],
        minio.get("MINIO_ROOT_PASSWORD") == expected["root_password"],
        backend.get("MINIO_ACCESS_KEY") == expected["access_key"],
        backend.get("MINIO_SECRET_KEY") == expected["secret_key"],
        minio_init.get("MINIO_ROOT_USER") == expected["root_user"],
        minio_init.get("MINIO_ROOT_PASSWORD") == expected["root_password"],
        minio_init.get("MINIO_ACCESS_KEY") == expected["access_key"],
        minio_init.get("MINIO_SECRET_KEY") == expected["secret_key"],
        spark_worker is None or spark_worker.get("MINIO_ACCESS_KEY") == expected["access_key"],
        spark_worker is None or spark_worker.get("MINIO_SECRET_KEY") == expected["secret_key"],
    ))
except (AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError):
    valid = False

raise SystemExit(0 if valid else 1)
' || compose_wiring_status=$?

unset ASKLAKE_PREFLIGHT_MINIO_ROOT_USER
unset ASKLAKE_PREFLIGHT_MINIO_ROOT_PASSWORD
unset ASKLAKE_PREFLIGHT_MINIO_ACCESS_KEY
unset ASKLAKE_PREFLIGHT_MINIO_SECRET_KEY

if (( compose_wiring_status != 0 )); then
  printf '%s\n' \
    'error: Compose must wire MINIO_ROOT_* to minio/minio-init and the distinct MINIO_ACCESS_KEY/MINIO_SECRET_KEY application pair to backend/minio-init/spark-worker' >&2
  exit 1
fi

printf 'Deployment environment preflight passed for %s\n' "$app_domain"
