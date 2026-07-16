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

trino_enabled_value="$(printf '%s' "$(env_value_for TRINO_ENABLED)" | tr '[:upper:]' '[:lower:]')"
case "$trino_enabled_value" in
  true|1|yes)
    trino_enabled=true
    ;;
  ""|false|0|no)
    trino_enabled=false
    ;;
  *)
    printf 'error: TRINO_ENABLED must be true or false in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

has_compose_profile() {
  local requested_profile="$1"
  local configured_profiles
  configured_profiles="$(env_value_for COMPOSE_PROFILES)"
  configured_profiles="${configured_profiles//[[:space:]]/}"
  [[ ",$configured_profiles," == *",$requested_profile,"* ]]
}

if [[ "$trino_enabled" == "true" ]]; then
  has_compose_profile trino || {
    printf 'error: COMPOSE_PROFILES must include trino when TRINO_ENABLED=true\n' >&2
    exit 1
  }
elif has_compose_profile trino; then
  printf 'error: COMPOSE_PROFILES must not include trino when TRINO_ENABLED=false\n' >&2
  exit 1
fi

required_keys=(
  AIRFLOW_API_AUTH_JWT_SECRET
  AIRFLOW_EXECUTION_API_TOKEN
  AIRFLOW_FERNET_KEY
  AIRFLOW_INTERNAL_TOKEN
  AIRFLOW_METADATA_DB_PASSWORD
  AIRFLOW_PASSWORD
  AI_CONTEXT_SIGNING_SECRET
  AI_GATEWAY_SERVICE_TOKEN
  AI_MCP_SERVICE_TOKEN
  AI_PROVIDER_API_KEY
  APP_DOMAIN
  APP_ENV
  ASKLAKE_HOST_DATA_DIR
  ASKLAKE_OBJECT_STORAGE_PROVIDER
  ASKLAKE_REPLAY_HOST_INPUT_DIR
  MONGO_INITDB_ROOT_PASSWORD
  MONGO_INITDB_ROOT_USERNAME
  OPENSEARCH_INITIAL_ADMIN_PASSWORD
  OPENSEARCH_PASSWORD
  POSTGRES_DB
  POSTGRES_PASSWORD
  POSTGRES_USER
  RAG_WORKER_TOKEN
  VITE_API_BASE_URL
)

storage_provider="$(env_value_for ASKLAKE_OBJECT_STORAGE_PROVIDER)"
storage_provider="$(printf '%s' "$storage_provider" | tr '[:upper:]' '[:lower:]')"
case "$storage_provider" in
  aws|s3)
    storage_provider="aws"
    required_keys+=(
      ASKLAKE_RAW_BUCKET
      ASKLAKE_S3_READINESS_READ_BUCKETS
      ASKLAKE_S3_READINESS_WRITE_BUCKETS
      ASKLAKE_SPARK_OUTPUT_BUCKET
      AWS_REGION
      S3_ALLOWED_BUCKETS
    )
    ;;
  minio)
    required_keys+=(MINIO_ACCESS_KEY MINIO_ROOT_PASSWORD MINIO_ROOT_USER MINIO_SECRET_KEY)
    ;;
  *)
    printf 'error: ASKLAKE_OBJECT_STORAGE_PROVIDER must be aws or minio in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

if [[ "$trino_enabled" == "true" ]]; then
  [[ "$storage_provider" == "aws" ]] || {
    printf 'error: production Trino currently requires ASKLAKE_OBJECT_STORAGE_PROVIDER=aws\n' >&2
    exit 1
  }
  required_keys+=(
    COMPOSE_PROFILES
    TRINO_AUTH_PASSWORD
    TRINO_AUTH_USERNAME
    TRINO_BASE_URL
    TRINO_CATALOG
    TRINO_ICEBERG_JDBC_PASSWORD
    TRINO_ICEBERG_JDBC_USER
    TRINO_ICEBERG_WAREHOUSE_BUCKET
    TRINO_INTERNAL_SHARED_SECRET
    TRINO_MATERIALIZER_PASSWORD
    TRINO_MATERIALIZER_USERNAME
    TRINO_PASSWORD_FILE
    TRINO_QUERY_CONFIRMATION_SECRET
    TRINO_RESULT_CURSOR_SECRET
    TRINO_RESULT_STORAGE_BUCKET
    TRINO_SCHEMA
    TRINO_TLS_CA_CONTAINER_FILE
    TRINO_TLS_CA_FILE
    TRINO_TLS_KEYSTORE_FILE
    TRINO_TLS_KEYSTORE_PASSWORD
    TRINO_USER
  )
fi

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

for ai_secret_key in AI_CONTEXT_SIGNING_SECRET AI_GATEWAY_SERVICE_TOKEN AI_MCP_SERVICE_TOKEN; do
  ai_secret_value="$(env_value_for "$ai_secret_key")"
  if (( ${#ai_secret_value} < 32 )); then
    printf 'error: %s must contain at least 32 characters\n' "$ai_secret_key" >&2
    exit 1
  fi
done

if [[ "$trino_enabled" == "true" ]]; then
  [[ "$(env_value_for TRINO_BASE_URL)" == "https://trino:8443" ]] || {
    printf 'error: TRINO_BASE_URL must be https://trino:8443 for the production Compose service\n' >&2
    exit 1
  }
  [[ "$(env_value_for TRINO_CATALOG)" == "iceberg" && "$(env_value_for TRINO_SCHEMA)" == "asklake" ]] || {
    printf 'error: TRINO_CATALOG=iceberg and TRINO_SCHEMA=asklake are required by the checked-in ACL\n' >&2
    exit 1
  }
  [[ "$(env_value_for TRINO_USER)" == "asklake-api" \
    && "$(env_value_for TRINO_AUTH_USERNAME)" == "asklake-api" \
    && "$(env_value_for TRINO_MATERIALIZER_USERNAME)" == "asklake-materializer" ]] || {
    printf 'error: Trino usernames must match the checked-in ACL (asklake-api / asklake-materializer)\n' >&2
    exit 1
  }
  [[ "$(env_value_for TRINO_TLS_CA_CONTAINER_FILE)" == "/run/secrets/trino-ca.pem" ]] || {
    printf 'error: TRINO_TLS_CA_CONTAINER_FILE must be /run/secrets/trino-ca.pem\n' >&2
    exit 1
  }

  trino_auth_password="$(env_value_for TRINO_AUTH_PASSWORD)"
  trino_materializer_password="$(env_value_for TRINO_MATERIALIZER_PASSWORD)"
  [[ "$trino_auth_password" != "$trino_materializer_password" ]] || {
    printf 'error: TRINO_AUTH_PASSWORD and TRINO_MATERIALIZER_PASSWORD must be distinct\n' >&2
    exit 1
  }
  for key in TRINO_AUTH_PASSWORD TRINO_MATERIALIZER_PASSWORD TRINO_ICEBERG_JDBC_PASSWORD TRINO_TLS_KEYSTORE_PASSWORD; do
    value="$(env_value_for "$key")"
    if (( ${#value} < 16 )); then
      printf 'error: %s must contain at least 16 characters\n' "$key" >&2
      exit 1
    fi
  done
  for key in TRINO_RESULT_CURSOR_SECRET TRINO_QUERY_CONFIRMATION_SECRET TRINO_INTERNAL_SHARED_SECRET; do
    value="$(env_value_for "$key")"
    if (( ${#value} < 32 )); then
      printf 'error: %s must contain at least 32 characters\n' "$key" >&2
      exit 1
    fi
  done

  trino_result_bucket="$(env_value_for TRINO_RESULT_STORAGE_BUCKET)"
  trino_warehouse_bucket="$(env_value_for TRINO_ICEBERG_WAREHOUSE_BUCKET)"
  [[ "$trino_result_bucket" != "$trino_warehouse_bucket" ]] || {
    printf 'error: TRINO_RESULT_STORAGE_BUCKET and TRINO_ICEBERG_WAREHOUSE_BUCKET must be distinct\n' >&2
    exit 1
  }
  readiness_write_buckets=",$(env_value_for ASKLAKE_S3_READINESS_WRITE_BUCKETS),"
  for required_bucket in "$trino_result_bucket" "$trino_warehouse_bucket"; do
    if [[ "$readiness_write_buckets" != *",$required_bucket,"* ]]; then
      printf 'error: ASKLAKE_S3_READINESS_WRITE_BUCKETS must include %s when Trino is enabled\n' "$required_bucket" >&2
      exit 1
    fi
  done
fi

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
if [[ "$storage_provider" == "minio" \
  && ( "$minio_access_key" == "$minio_root_user" || "$minio_secret_key" == "$minio_root_password" ) ]]; then
    printf 'error: MinIO application credentials must be distinct from MinIO root credentials\n' >&2
    exit 1
fi

if [[ "$storage_provider" == "aws" ]]; then
  for forbidden_key in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_ROOT_USER MINIO_ROOT_PASSWORD TRINO_RESULT_STORAGE_ACCESS_KEY TRINO_RESULT_STORAGE_SECRET_KEY TRINO_S3_ACCESS_KEY TRINO_S3_SECRET_KEY; do
    if ! is_blank "$(env_value_for "$forbidden_key")"; then
      printf 'error: %s must not be stored in an AWS production deployment env; use the EC2 instance role\n' "$forbidden_key" >&2
      exit 1
    fi
  done
fi

app_env="$(env_value_for APP_ENV)"
[[ "$app_env" == "production" ]] || {
  printf 'error: APP_ENV must be production in %s\n' "$ENV_FILE" >&2
  exit 1
}

backend_legacy_demo_users="$(env_value_for AUTH_LEGACY_DEMO_USERS_ENABLED)"
frontend_legacy_demo_users="$(env_value_for VITE_AUTH_LEGACY_DEMO_USERS_ENABLED)"
backend_legacy_demo_users="${backend_legacy_demo_users:-false}"
frontend_legacy_demo_users="${frontend_legacy_demo_users:-false}"
for value in "$backend_legacy_demo_users" "$frontend_legacy_demo_users"; do
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    printf 'error: legacy demo user flags must be lowercase true or false in %s\n' "$ENV_FILE" >&2
    exit 1
  fi
done
if [[ "$backend_legacy_demo_users" != "$frontend_legacy_demo_users" ]]; then
  printf 'error: AUTH_LEGACY_DEMO_USERS_ENABLED and VITE_AUTH_LEGACY_DEMO_USERS_ENABLED must match in %s\n' "$ENV_FILE" >&2
  exit 1
fi

app_domain="$(env_value_for APP_DOMAIN)"
if [[ ! "$app_domain" =~ ^[A-Za-z0-9.-]+$ \
  || "$app_domain" == "localhost" \
  || "$app_domain" == "asklake.example.com" \
  || "$app_domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'error: APP_DOMAIN must be the deployed HTTPS DNS name, not a URL, placeholder, localhost, or bare IP\n' >&2
  exit 1
fi

vite_api_base_url="$(env_value_for VITE_API_BASE_URL)"
expected_api_origin="https://${app_domain}"
if [[ "$vite_api_base_url" != "$expected_api_origin" ]]; then
  printf 'error: VITE_API_BASE_URL must exactly match %s for the production APP_DOMAIN (without /api or a trailing slash)\n' "$expected_api_origin" >&2
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

require_host_file() {
  local key="$1"
  local file="$2"

  if [[ "$file" != /* ]]; then
    printf 'error: %s must be an absolute host file path\n' "$key" >&2
    exit 1
  fi
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    printf 'error: %s file does not exist or is not readable: %s\n' "$key" "$file" >&2
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

if [[ "$trino_enabled" == "true" ]]; then
  require_host_file TRINO_TLS_CA_FILE "$(env_value_for TRINO_TLS_CA_FILE)"
  require_host_file TRINO_TLS_KEYSTORE_FILE "$(env_value_for TRINO_TLS_KEYSTORE_FILE)"
  trino_password_file="$(env_value_for TRINO_PASSWORD_FILE)"
  require_host_file TRINO_PASSWORD_FILE "$trino_password_file"
  for required_trino_user in asklake-api asklake-materializer; do
    if ! grep -q "^${required_trino_user}:" "$trino_password_file"; then
      printf 'error: TRINO_PASSWORD_FILE must contain the checked-in ACL user %s\n' "$required_trino_user" >&2
      exit 1
    fi
  done
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet

export ASKLAKE_PREFLIGHT_MINIO_ROOT_USER="$minio_root_user"
export ASKLAKE_PREFLIGHT_MINIO_ROOT_PASSWORD="$minio_root_password"
export ASKLAKE_PREFLIGHT_MINIO_ACCESS_KEY="$minio_access_key"
export ASKLAKE_PREFLIGHT_MINIO_SECRET_KEY="$minio_secret_key"
export ASKLAKE_PREFLIGHT_OBJECT_STORAGE_PROVIDER="$storage_provider"
export ASKLAKE_PREFLIGHT_AWS_REGION="$(env_value_for AWS_REGION)"
export ASKLAKE_PREFLIGHT_RAW_BUCKET="$(env_value_for ASKLAKE_RAW_BUCKET)"
export ASKLAKE_PREFLIGHT_OUTPUT_BUCKET="$(env_value_for ASKLAKE_SPARK_OUTPUT_BUCKET)"
export ASKLAKE_PREFLIGHT_TRINO_RESULT_BUCKET="$(env_value_for TRINO_RESULT_STORAGE_BUCKET)"
export ASKLAKE_PREFLIGHT_TRINO_WAREHOUSE_BUCKET="$(env_value_for TRINO_ICEBERG_WAREHOUSE_BUCKET)"
export ASKLAKE_PREFLIGHT_TRINO_ENABLED="$trino_enabled"

compose_wiring_status=0
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json \
  | python3 -c '
import json
import os
import sys

try:
    document = json.load(sys.stdin)
    services = document["services"]
    networks = document.get("networks", {})
    backend = services["backend"]["environment"]
    spark_worker_service = services.get("spark-worker")
    spark_worker = spark_worker_service.get("environment", {}) if spark_worker_service else None
    provider = os.environ["ASKLAKE_PREFLIGHT_OBJECT_STORAGE_PROVIDER"]
    trino_enabled = os.environ["ASKLAKE_PREFLIGHT_TRINO_ENABLED"] == "true"
    profiled_trino_services = {
        "trino", "trino-postgres-bootstrap", "trino-result-collector", "trino-result-cleanup"
    }
    profile_wiring_valid = (
        profiled_trino_services.issubset(services)
        if trino_enabled
        else profiled_trino_services.isdisjoint(services)
    )
    if provider == "aws":
        readiness = services["aws-s3-readiness"]["environment"]
        forbidden = {
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD",
            "TRINO_RESULT_STORAGE_ACCESS_KEY", "TRINO_RESULT_STORAGE_SECRET_KEY",
            "TRINO_S3_ACCESS_KEY", "TRINO_S3_SECRET_KEY",
        }
        readiness_write_buckets = {
            value.strip()
            for value in readiness.get("ASKLAKE_S3_READINESS_WRITE_BUCKETS", "").split(",")
            if value.strip()
        }
        valid = all((
            profile_wiring_valid,
            "minio" not in services,
            "minio-init" not in services,
            "trino-storage-bootstrap" not in services,
            backend.get("ASKLAKE_OBJECT_STORAGE_PROVIDER") == "aws",
            backend.get("ASKLAKE_RAW_BUCKET") == os.environ["ASKLAKE_PREFLIGHT_RAW_BUCKET"],
            backend.get("ASKLAKE_SPARK_OUTPUT_BUCKET") == os.environ["ASKLAKE_PREFLIGHT_OUTPUT_BUCKET"],
            backend.get("AWS_REGION") == os.environ["ASKLAKE_PREFLIGHT_AWS_REGION"],
            readiness.get("ASKLAKE_OBJECT_STORAGE_PROVIDER") == "aws",
            readiness.get("AWS_REGION") == os.environ["ASKLAKE_PREFLIGHT_AWS_REGION"],
            not any(name in backend for name in forbidden),
            spark_worker is None or not any(name in spark_worker for name in forbidden),
        ))
        if trino_enabled:
            trino_service = services["trino"]
            trino = trino_service["environment"]
            required_trino_buckets = {
                os.environ["ASKLAKE_PREFLIGHT_TRINO_RESULT_BUCKET"],
                os.environ["ASKLAKE_PREFLIGHT_TRINO_WAREHOUSE_BUCKET"],
            }
            trino_networks = set(trino_service.get("networks", {}))
            valid = valid and all((
                backend.get("TRINO_ENABLED") == "true",
                backend.get("TRINO_RESULT_STORAGE_BUCKET") == os.environ["ASKLAKE_PREFLIGHT_TRINO_RESULT_BUCKET"],
                backend.get("TRINO_TLS_CA_FILE") == "/run/secrets/trino-ca.pem",
                required_trino_buckets.issubset(readiness_write_buckets),
                trino.get("TRINO_ICEBERG_WAREHOUSE_BUCKET") == os.environ["ASKLAKE_PREFLIGHT_TRINO_WAREHOUSE_BUCKET"],
                trino.get("TRINO_S3_REGION") == os.environ["ASKLAKE_PREFLIGHT_AWS_REGION"],
                {"trino_internal", "trino_egress"}.issubset(trino_networks),
                networks.get("trino_internal", {}).get("internal") is True,
                networks.get("trino_egress", {}).get("internal") is not True,
                not any(name in trino for name in forbidden),
            ))
        else:
            valid = valid and backend.get("TRINO_ENABLED") == "false"
    else:
        minio = services["minio"]["environment"]
        minio_init = services["minio-init"]["environment"]
        expected = {
            "root_user": os.environ["ASKLAKE_PREFLIGHT_MINIO_ROOT_USER"],
            "root_password": os.environ["ASKLAKE_PREFLIGHT_MINIO_ROOT_PASSWORD"],
            "access_key": os.environ["ASKLAKE_PREFLIGHT_MINIO_ACCESS_KEY"],
            "secret_key": os.environ["ASKLAKE_PREFLIGHT_MINIO_SECRET_KEY"],
        }
        valid = all((
            profile_wiring_valid,
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
unset ASKLAKE_PREFLIGHT_OBJECT_STORAGE_PROVIDER
unset ASKLAKE_PREFLIGHT_AWS_REGION
unset ASKLAKE_PREFLIGHT_RAW_BUCKET
unset ASKLAKE_PREFLIGHT_OUTPUT_BUCKET
unset ASKLAKE_PREFLIGHT_TRINO_RESULT_BUCKET
unset ASKLAKE_PREFLIGHT_TRINO_WAREHOUSE_BUCKET
unset ASKLAKE_PREFLIGHT_TRINO_ENABLED

if (( compose_wiring_status != 0 )); then
  printf 'error: Compose object-storage wiring does not match the selected %s provider contract\n' "$storage_provider" >&2
  exit 1
fi

printf 'Deployment environment preflight passed for %s\n' "$app_domain"
