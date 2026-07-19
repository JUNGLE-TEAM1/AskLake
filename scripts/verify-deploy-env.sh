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

continuous_sql_join_enabled_value="$(printf '%s' "$(env_value_for CONTINUOUS_SQL_JOIN_ENABLED)" | tr '[:upper:]' '[:lower:]')"
case "$continuous_sql_join_enabled_value" in
  true|1|yes)
    continuous_sql_join_enabled=true
    ;;
  ""|false|0|no)
    continuous_sql_join_enabled=false
    ;;
  *)
    printf 'error: CONTINUOUS_SQL_JOIN_ENABLED must be true or false in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

clickhouse_enabled_value="$(printf '%s' "$(env_value_for CLICKHOUSE_CONTINUOUS_JOIN_ENABLED)" | tr '[:upper:]' '[:lower:]')"
case "$clickhouse_enabled_value" in
  true|1|yes)
    clickhouse_enabled=true
    ;;
  ""|false|0|no)
    clickhouse_enabled=false
    ;;
  *)
    printf 'error: CLICKHOUSE_CONTINUOUS_JOIN_ENABLED must be true or false in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

clickhouse_v2_enabled_value="$(printf '%s' "$(env_value_for CLICKHOUSE_REALTIME_V2_ENABLED)" | tr '[:upper:]' '[:lower:]')"
case "$clickhouse_v2_enabled_value" in
  true|1|yes)
    clickhouse_v2_enabled=true
    ;;
  ""|false|0|no)
    clickhouse_v2_enabled=false
    ;;
  *)
    printf 'error: CLICKHOUSE_REALTIME_V2_ENABLED must be true or false in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

kafka_connect_enabled_value="$(printf '%s' "$(env_value_for KAFKA_CONNECT_SINK_ENABLED)" | tr '[:upper:]' '[:lower:]')"
case "$kafka_connect_enabled_value" in
  true|1|yes)
    kafka_connect_enabled=true
    ;;
  ""|false|0|no)
    kafka_connect_enabled=false
    ;;
  *)
    printf 'error: KAFKA_CONNECT_SINK_ENABLED must be true or false in %s\n' "$ENV_FILE" >&2
    exit 1
    ;;
esac

clickhouse_consumer_owner="$(env_value_for CLICKHOUSE_REALTIME_CONSUMER_OWNER)"
clickhouse_consumer_owner="${clickhouse_consumer_owner:-disabled}"
case "$clickhouse_consumer_owner" in
  disabled|kafka_engine_v1|kafka_connect_v2)
    ;;
  *)
    printf 'error: CLICKHOUSE_REALTIME_CONSUMER_OWNER must be disabled, kafka_engine_v1, or kafka_connect_v2\n' >&2
    exit 1
    ;;
esac

kafka_connect_connector_name="$(env_value_for KAFKA_CONNECT_CONNECTOR_NAME)"
kafka_connect_connector_name="${kafka_connect_connector_name:-asklake-clickhouse-realtime-v2}"

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


if [[ "$clickhouse_enabled" == "true" ]]; then
  [[ "$trino_enabled" == "true" ]] || {
    printf 'error: TRINO_ENABLED must be true when CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true\n' >&2
    exit 1
  }
  has_compose_profile clickhouse || {
    printf 'error: COMPOSE_PROFILES must include clickhouse when CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true\n' >&2
    exit 1
  }
elif has_compose_profile clickhouse; then
  printf 'error: COMPOSE_PROFILES must not include clickhouse when CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=false\n' >&2
  exit 1
fi

if has_compose_profile clickhouse-realtime-v2; then
  clickhouse_v2_infra_enabled=true
  command -v openssl >/dev/null 2>&1 || {
    printf 'error: required ClickHouse V2 TLS preflight command not found: openssl\n' >&2
    exit 1
  }
else
  clickhouse_v2_infra_enabled=false
fi

if [[ "$clickhouse_v2_enabled" == "true" && "$clickhouse_v2_infra_enabled" != "true" ]]; then
  printf 'error: COMPOSE_PROFILES must include clickhouse-realtime-v2 when CLICKHOUSE_REALTIME_V2_ENABLED=true\n' >&2
  exit 1
fi

if [[ "$kafka_connect_enabled" == "true" || "$clickhouse_consumer_owner" == "kafka_connect_v2" ]]; then
  [[ "$clickhouse_v2_enabled" == "true" \
    && "$kafka_connect_enabled" == "true" \
    && "$clickhouse_consumer_owner" == "kafka_connect_v2" \
    && "$clickhouse_v2_infra_enabled" == "true" ]] || {
    printf 'error: Kafka Connect V2 ownership requires V2, sink, owner, and Compose profile to be enabled together\n' >&2
    exit 1
  }
  [[ "$clickhouse_enabled" == "false" ]] || {
    printf 'error: Kafka Engine V1 and Kafka Connect V2 cannot own the same active generation\n' >&2
    exit 1
  }
fi

if [[ "$clickhouse_enabled" == "true" || "$clickhouse_consumer_owner" == "kafka_engine_v1" ]]; then
  [[ "$continuous_sql_join_enabled" == "true" && "$clickhouse_enabled" == "true" ]] || {
    printf 'error: Kafka Engine V1 requires CONTINUOUS_SQL_JOIN_ENABLED=true and CLICKHOUSE_CONTINUOUS_JOIN_ENABLED=true\n' >&2
    exit 1
  }
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

if [[ "$clickhouse_v2_infra_enabled" == "true" ]]; then
  required_keys+=(
    CLICKHOUSE_V2_ADMIN_PASSWORD
    CLICKHOUSE_V2_ADMIN_USER
    CLICKHOUSE_V2_DATABASE
    CLICKHOUSE_V2_IMAGE
    CLICKHOUSE_V2_INGEST_PASSWORD
    CLICKHOUSE_V2_MATERIALIZER_PASSWORD
    CLICKHOUSE_V2_MATERIALIZER_USER
    CLICKHOUSE_V2_MIGRATION_PASSWORD
    CLICKHOUSE_V2_OBSERVER_PASSWORD
    CLICKHOUSE_V2_READER_PASSWORD
    CLICKHOUSE_V2_READER_USER
    CLICKHOUSE_V2_URL
    CLICKHOUSE_V2_TLS_CA_FILE
    CLICKHOUSE_V2_TLS_CA_CONTAINER_FILE
    CLICKHOUSE_V2_TLS_CERT_FILE
    CLICKHOUSE_V2_TLS_KEY_FILE
    COMPOSE_PROFILES
    KAFKA_CONNECT_V2_IMAGE
    KAFKA_CONNECT_V2_SECRETS_FILE
  )
fi

if [[ "$kafka_connect_enabled" == "true" ]]; then
  required_keys+=(
    KAFKA_CONNECT_CONNECTOR_NAME
    KAFKA_CONNECT_URL
  )
fi

if [[ "$clickhouse_enabled" == "true" ]]; then
  required_keys+=(
    CLICKHOUSE_DATABASE
    CLICKHOUSE_PASSWORD
    CLICKHOUSE_URL
    CLICKHOUSE_USER
  )
fi

if [[ "$clickhouse_v2_infra_enabled" == "true" ]]; then
  for key in CLICKHOUSE_V2_DATABASE CLICKHOUSE_V2_ADMIN_USER; do
    value="$(env_value_for "$key")"
    [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
      printf 'error: %s must be a safe stable identifier\n' "$key" >&2
      exit 1
    }
  done
  clickhouse_v2_database_normalized="$(printf '%s' "$(env_value_for CLICKHOUSE_V2_DATABASE)" | tr '[:upper:]' '[:lower:]')"
  case "$clickhouse_v2_database_normalized" in
    default|information_schema|system)
      printf 'error: CLICKHOUSE_V2_DATABASE must not use a built-in or reserved database name\n' >&2
      exit 1
      ;;
  esac
  clickhouse_v2_admin_user_normalized="$(printf '%s' "$(env_value_for CLICKHOUSE_V2_ADMIN_USER)" | tr '[:upper:]' '[:lower:]')"
  case "$clickhouse_v2_admin_user_normalized" in
    asklake_v2_ingest|asklake_v2_materializer|asklake_v2_reader|asklake_v2_migration|asklake_v2_observer|\
    asklake_v2_ingest_role|asklake_v2_materializer_role|asklake_v2_reader_role|asklake_v2_migration_role|asklake_v2_observer_role)
      printf 'error: CLICKHOUSE_V2_ADMIN_USER must be distinct from fixed runtime users and roles\n' >&2
      exit 1
      ;;
  esac
  for key in CLICKHOUSE_V2_IMAGE KAFKA_CONNECT_V2_IMAGE; do
    value="$(env_value_for "$key")"
    [[ "$value" =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
      printf 'error: %s must be an immutable image reference ending in @sha256:<64 lowercase hex>\n' "$key" >&2
      exit 1
    }
  done
  [[ "$(env_value_for CLICKHOUSE_V2_URL)" == "https://clickhouse-v2:8443" ]] || {
    printf 'error: CLICKHOUSE_V2_URL must be the private https://clickhouse-v2:8443 origin\n' >&2
    exit 1
  }
  [[ "$(env_value_for CLICKHOUSE_V2_MATERIALIZER_USER)" == "asklake_v2_materializer" ]] || {
    printf 'error: CLICKHOUSE_V2_MATERIALIZER_USER must use the fixed materializer identity\n' >&2
    exit 1
  }
  [[ "$(env_value_for CLICKHOUSE_V2_READER_USER)" == "asklake_v2_reader" ]] || {
    printf 'error: CLICKHOUSE_V2_READER_USER must use the fixed reader identity\n' >&2
    exit 1
  }
  [[ "$(env_value_for CLICKHOUSE_V2_TLS_CA_CONTAINER_FILE)" == "/run/secrets/clickhouse-v2-ca.crt" ]] || {
    printf 'error: CLICKHOUSE_V2_TLS_CA_CONTAINER_FILE must use the fixed backend trust path\n' >&2
    exit 1
  }

  clickhouse_v2_secrets=(
    "$(env_value_for CLICKHOUSE_V2_ADMIN_PASSWORD)"
    "$(env_value_for CLICKHOUSE_V2_INGEST_PASSWORD)"
    "$(env_value_for CLICKHOUSE_V2_MATERIALIZER_PASSWORD)"
    "$(env_value_for CLICKHOUSE_V2_READER_PASSWORD)"
    "$(env_value_for CLICKHOUSE_V2_MIGRATION_PASSWORD)"
    "$(env_value_for CLICKHOUSE_V2_OBSERVER_PASSWORD)"
  )
  for secret in "${clickhouse_v2_secrets[@]}"; do
    if (( ${#secret} < 16 )) || [[ "$secret" == *replace-with-* ]]; then
      printf 'error: every ClickHouse V2 account password must be a non-placeholder value with at least 16 characters\n' >&2
      exit 1
    fi
  done
  for left_index in "${!clickhouse_v2_secrets[@]}"; do
    for right_index in "${!clickhouse_v2_secrets[@]}"; do
      if (( left_index < right_index )) \
        && [[ "${clickhouse_v2_secrets[$left_index]}" == "${clickhouse_v2_secrets[$right_index]}" ]]; then
        printf 'error: ClickHouse V2 account passwords must be pairwise distinct\n' >&2
        exit 1
      fi
    done
  done
fi

if [[ "$kafka_connect_enabled" == "true" ]]; then
  [[ "$(env_value_for KAFKA_CONNECT_URL)" == "http://kafka-connect-v2:8083" ]] || {
    printf 'error: KAFKA_CONNECT_URL must be the private http://kafka-connect-v2:8083 origin\n' >&2
    exit 1
  }
  [[ "$(env_value_for KAFKA_CONNECT_CONNECTOR_NAME)" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
    printf 'error: KAFKA_CONNECT_CONNECTOR_NAME must be a safe stable connector identity\n' >&2
    exit 1
  }
else
  is_blank "$(env_value_for KAFKA_CONNECT_URL)" || {
    printf 'error: KAFKA_CONNECT_URL must be blank when KAFKA_CONNECT_SINK_ENABLED=false\n' >&2
    exit 1
  }
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

if [[ "$clickhouse_enabled" == "true" ]]; then
  [[ "$(env_value_for CLICKHOUSE_URL)" == "http://clickhouse:8123" ]] || {
    printf 'error: CLICKHOUSE_URL must be http://clickhouse:8123 for the production Compose service\n' >&2
    exit 1
  }
  clickhouse_password="$(env_value_for CLICKHOUSE_PASSWORD)"
  if (( ${#clickhouse_password} < 16 )) || [[ "$clickhouse_password" == *replace-with-* ]]; then
    printf 'error: CLICKHOUSE_PASSWORD must be a non-placeholder value with at least 16 characters\n' >&2
    exit 1
  fi
  clickhouse_database="$(env_value_for CLICKHOUSE_DATABASE)"
  clickhouse_user="$(env_value_for CLICKHOUSE_USER)"
  [[ "$clickhouse_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    printf 'error: CLICKHOUSE_DATABASE must be a safe identifier\n' >&2
    exit 1
  }
  [[ "$clickhouse_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    printf 'error: CLICKHOUSE_USER must be a safe identifier\n' >&2
    exit 1
  }
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
frontend_mock_mode="$(env_value_for VITE_USE_MOCK_API)"
if [[ -n "$frontend_mock_mode" && "$frontend_mock_mode" != "false" ]]; then
  printf 'error: VITE_USE_MOCK_API is no longer supported by the production frontend\n' >&2
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

if [[ "$clickhouse_v2_infra_enabled" == "true" ]]; then
  clickhouse_v2_tls_cert_file="$(env_value_for CLICKHOUSE_V2_TLS_CERT_FILE)"
  clickhouse_v2_tls_key_file="$(env_value_for CLICKHOUSE_V2_TLS_KEY_FILE)"
  clickhouse_v2_tls_ca_file="$(env_value_for CLICKHOUSE_V2_TLS_CA_FILE)"
  require_host_file CLICKHOUSE_V2_TLS_CERT_FILE "$clickhouse_v2_tls_cert_file"
  require_host_file CLICKHOUSE_V2_TLS_KEY_FILE "$clickhouse_v2_tls_key_file"
  require_host_file CLICKHOUSE_V2_TLS_CA_FILE "$clickhouse_v2_tls_ca_file"
  if ! openssl verify -CAfile "$clickhouse_v2_tls_ca_file" "$clickhouse_v2_tls_cert_file" >/dev/null 2>&1; then
    printf 'error: CLICKHOUSE_V2_TLS_CERT_FILE must verify against CLICKHOUSE_V2_TLS_CA_FILE\n' >&2
    exit 1
  fi
  if ! python3 - "$clickhouse_v2_tls_cert_file" <<'PY'
import ssl
import sys

certificate = ssl._ssl._test_decode_cert(sys.argv[1])
expected_name = "clickhouse-v2"
dns_names = {
    str(value).casefold()
    for name_type, value in certificate.get("subjectAltName", ())
    if name_type == "DNS"
}
if dns_names:
    valid = expected_name in dns_names
else:
    common_names = {
        str(value).casefold()
        for relative_name in certificate.get("subject", ())
        for name_type, value in relative_name
        if name_type == "commonName"
    }
    valid = expected_name in common_names
raise SystemExit(0 if valid else 1)
PY
  then
    printf 'error: CLICKHOUSE_V2_TLS_CERT_FILE must include clickhouse-v2 in its SAN or subject name\n' >&2
    exit 1
  fi
  clickhouse_v2_cert_pubkey_digest="$(openssl x509 -in "$clickhouse_v2_tls_cert_file" -pubkey -noout \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256)"
  clickhouse_v2_key_pubkey_digest="$(openssl pkey -in "$clickhouse_v2_tls_key_file" -pubout -outform DER 2>/dev/null \
    | openssl dgst -sha256)"
  [[ -n "$clickhouse_v2_cert_pubkey_digest" \
    && "$clickhouse_v2_cert_pubkey_digest" == "$clickhouse_v2_key_pubkey_digest" ]] || {
    printf 'error: CLICKHOUSE_V2_TLS_KEY_FILE must match CLICKHOUSE_V2_TLS_CERT_FILE\n' >&2
    exit 1
  }
  if ! python3 -c '
import os
import stat
import sys

mode = stat.S_IMODE(os.stat(sys.argv[1]).st_mode)
raise SystemExit(0 if mode & 0o077 == 0 else 1)
' "$clickhouse_v2_tls_key_file"; then
    printf 'error: CLICKHOUSE_V2_TLS_KEY_FILE must not be group/world accessible\n' >&2
    exit 1
  fi
  kafka_connect_v2_secrets_file="$(env_value_for KAFKA_CONNECT_V2_SECRETS_FILE)"
  require_host_file KAFKA_CONNECT_V2_SECRETS_FILE "$kafka_connect_v2_secrets_file"
  kafka_connect_v2_ingest_password="$(sed -n 's/^clickhouse\.ingest\.password=//p' "$kafka_connect_v2_secrets_file")"
  [[ -n "$kafka_connect_v2_ingest_password" \
    && "$kafka_connect_v2_ingest_password" == "$(env_value_for CLICKHOUSE_V2_INGEST_PASSWORD)" ]] || {
    printf 'error: KAFKA_CONNECT_V2_SECRETS_FILE must contain the configured clickhouse.ingest.password\n' >&2
    exit 1
  }
  if ! python3 -c '
import os
import stat
import sys

mode = stat.S_IMODE(os.stat(sys.argv[1]).st_mode)
raise SystemExit(0 if mode & 0o077 == 0 else 1)
' "$kafka_connect_v2_secrets_file"; then
    printf 'error: KAFKA_CONNECT_V2_SECRETS_FILE must not be group/world accessible\n' >&2
    exit 1
  fi
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
export ASKLAKE_PREFLIGHT_CONTINUOUS_SQL_JOIN_ENABLED="$continuous_sql_join_enabled"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_ENABLED="$clickhouse_enabled"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_ENABLED="$clickhouse_v2_enabled"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_INFRA_ENABLED="$clickhouse_v2_infra_enabled"
export ASKLAKE_PREFLIGHT_KAFKA_CONNECT_ENABLED="$kafka_connect_enabled"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_CONSUMER_OWNER="$clickhouse_consumer_owner"
export ASKLAKE_PREFLIGHT_KAFKA_CONNECT_URL="$(env_value_for KAFKA_CONNECT_URL)"
export ASKLAKE_PREFLIGHT_KAFKA_CONNECT_CONNECTOR_NAME="$kafka_connect_connector_name"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_DATABASE="$(env_value_for CLICKHOUSE_V2_DATABASE)"
export ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_IMAGE="$(env_value_for CLICKHOUSE_V2_IMAGE)"
export ASKLAKE_PREFLIGHT_KAFKA_CONNECT_V2_IMAGE="$(env_value_for KAFKA_CONNECT_V2_IMAGE)"

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
    continuous_sql_join_enabled = (
        os.environ["ASKLAKE_PREFLIGHT_CONTINUOUS_SQL_JOIN_ENABLED"] == "true"
    )
    clickhouse_enabled = os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_ENABLED"] == "true"
    clickhouse_v2_enabled = os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_ENABLED"] == "true"
    clickhouse_v2_infra_enabled = os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_INFRA_ENABLED"] == "true"
    kafka_connect_enabled = os.environ["ASKLAKE_PREFLIGHT_KAFKA_CONNECT_ENABLED"] == "true"
    clickhouse_consumer_owner = os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_CONSUMER_OWNER"]
    profiled_trino_services = {
        "trino", "trino-postgres-bootstrap", "trino-result-collector", "trino-result-cleanup"
    }
    profile_wiring_valid = (
        profiled_trino_services.issubset(services)
        if trino_enabled
        else profiled_trino_services.isdisjoint(services)
    )
    profile_wiring_valid = profile_wiring_valid and (
        ("clickhouse" in services) if clickhouse_enabled else ("clickhouse" not in services)
    )
    profiled_clickhouse_v2_services = {
        "clickhouse-keeper-v2", "clickhouse-v2", "kafka-connect-v2"
    }
    profile_wiring_valid = profile_wiring_valid and (
        profiled_clickhouse_v2_services.issubset(services)
        if clickhouse_v2_infra_enabled
        else profiled_clickhouse_v2_services.isdisjoint(services)
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
        if clickhouse_enabled:
            clickhouse = services["clickhouse"]["environment"]
            valid = valid and all((
                continuous_sql_join_enabled,
                backend.get("CONTINUOUS_SQL_JOIN_ENABLED") == "true",
                backend.get("CLICKHOUSE_CONTINUOUS_JOIN_ENABLED") == "true",
                backend.get("CLICKHOUSE_URL") == "http://clickhouse:8123",
                backend.get("CLICKHOUSE_USER") == clickhouse.get("CLICKHOUSE_USER"),
                backend.get("CLICKHOUSE_PASSWORD") == clickhouse.get("CLICKHOUSE_PASSWORD"),
            ))
        else:
            valid = valid and backend.get("CLICKHOUSE_CONTINUOUS_JOIN_ENABLED") == "false"
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
    backend_runtime_services = tuple(
        services[name] for name in ("backend", "continuous-worker") if name in services
    )
    valid = valid and all(
        runtime_service.get("environment", {}).get("CLICKHOUSE_REALTIME_V2_ENABLED")
        == ("true" if clickhouse_v2_enabled else "false")
        and runtime_service.get("environment", {}).get("KAFKA_CONNECT_SINK_ENABLED")
        == ("true" if kafka_connect_enabled else "false")
        and runtime_service.get("environment", {}).get("CLICKHOUSE_REALTIME_CONSUMER_OWNER")
        == clickhouse_consumer_owner
        and runtime_service.get("environment", {}).get("KAFKA_CONNECT_URL")
        == os.environ["ASKLAKE_PREFLIGHT_KAFKA_CONNECT_URL"]
        and runtime_service.get("environment", {}).get("KAFKA_CONNECT_CONNECTOR_NAME")
        == os.environ["ASKLAKE_PREFLIGHT_KAFKA_CONNECT_CONNECTOR_NAME"]
        and runtime_service.get("environment", {}).get("CLICKHOUSE_V2_URL")
        == "https://clickhouse-v2:8443"
        and runtime_service.get("environment", {}).get("CLICKHOUSE_V2_DATABASE")
        == os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_DATABASE"]
        and runtime_service.get("environment", {}).get("CLICKHOUSE_V2_MATERIALIZER_USER")
        == "asklake_v2_materializer"
        and runtime_service.get("environment", {}).get("CLICKHOUSE_V2_READER_USER")
        == "asklake_v2_reader"
        and runtime_service.get("environment", {}).get("CLICKHOUSE_V2_TLS_CA_FILE")
        == "/run/secrets/clickhouse-v2-ca.crt"
        for runtime_service in backend_runtime_services
    )
    if clickhouse_v2_infra_enabled:
        clickhouse_v2 = services["clickhouse-v2"]
        kafka_connect_v2 = services["kafka-connect-v2"]
        keeper_v2 = services["clickhouse-keeper-v2"]
        clickhouse_v2_environment = clickhouse_v2.get("environment", {})
        kafka_connect_v2_environment = kafka_connect_v2.get("environment", {})
        clickhouse_v2_bind_targets = {
            volume.get("target")
            for volume in clickhouse_v2.get("volumes", [])
            if volume.get("type") == "bind" and volume.get("read_only") is True
        }
        kafka_connect_v2_bind_targets = {
            volume.get("target")
            for volume in kafka_connect_v2.get("volumes", [])
            if volume.get("type") == "bind" and volume.get("read_only") is True
        }
        backend_networks = set(services["backend"].get("networks", {}))
        redpanda_networks = set(services["redpanda"].get("networks", {}))
        backend_ca_mounted = all(
            any(
                volume.get("target") == "/run/secrets/clickhouse-v2-ca.crt"
                and volume.get("type") == "bind"
                and volume.get("read_only") is True
                for volume in runtime_service.get("volumes", [])
            )
            for runtime_service in backend_runtime_services
        )
        valid = valid and all((
            backend_ca_mounted,
            clickhouse_v2.get("image") == os.environ["ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_IMAGE"],
            kafka_connect_v2.get("image") == os.environ["ASKLAKE_PREFLIGHT_KAFKA_CONNECT_V2_IMAGE"],
            "build" not in kafka_connect_v2,
            clickhouse_v2.get("entrypoint") == [
                "/bin/bash", "/usr/local/bin/asklake-clickhouse-v2-entrypoint.sh"
            ],
            clickhouse_v2.get("user") == "0:0",
            "no-new-privileges:true" in clickhouse_v2.get("security_opt", []),
            clickhouse_v2_environment.get("CLICKHOUSE_V2_TLS_STAGING_REQUIRED") == "true",
            clickhouse_v2.get("tmpfs") == [
                "/run/asklake-clickhouse-v2-secrets:rw,noexec,nosuid,nodev,mode=0700,uid=101,gid=101"
            ],
            {
                "/run/asklake-secrets-source/clickhouse-v2/server.crt",
                "/run/asklake-secrets-source/clickhouse-v2/server.key",
                "/run/asklake-secrets-source/clickhouse-v2/ca.crt",
            }.issubset(clickhouse_v2_bind_targets),
            kafka_connect_v2.get("entrypoint") == [
                "/usr/local/bin/asklake-kafka-connect-v2-entrypoint.sh"
            ],
            kafka_connect_v2.get("user") == "0:0",
            "no-new-privileges:true" in kafka_connect_v2.get("security_opt", []),
            kafka_connect_v2_environment.get("KAFKA_CONNECT_V2_TLS_CA_STAGING_REQUIRED") == "true",
            kafka_connect_v2.get("tmpfs") == [
                "/run/secrets:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000"
            ],
            {
                "/run/asklake-secrets-source/kafka-connect/asklake-clickhouse-v2.properties",
                "/run/asklake-secrets-source/kafka-connect/clickhouse-v2-ca.crt",
            }.issubset(kafka_connect_v2_bind_targets),
            not clickhouse_v2.get("ports"),
            not kafka_connect_v2.get("ports"),
            {"8443", "9440"} == {str(port) for port in clickhouse_v2.get("expose", [])},
            networks.get("clickhouse_v2_internal", {}).get("internal") is True,
            "clickhouse_v2_internal" in backend_networks,
            "clickhouse_v2_internal" in redpanda_networks,
            set(clickhouse_v2.get("networks", {})) == {"clickhouse_v2_internal"},
            set(kafka_connect_v2.get("networks", {})) == {"clickhouse_v2_internal"},
            set(keeper_v2.get("networks", {})) == {"clickhouse_v2_internal"},
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
unset ASKLAKE_PREFLIGHT_CONTINUOUS_SQL_JOIN_ENABLED
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_ENABLED
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_ENABLED
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_INFRA_ENABLED
unset ASKLAKE_PREFLIGHT_KAFKA_CONNECT_ENABLED
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_CONSUMER_OWNER
unset ASKLAKE_PREFLIGHT_KAFKA_CONNECT_URL
unset ASKLAKE_PREFLIGHT_KAFKA_CONNECT_CONNECTOR_NAME
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_DATABASE
unset ASKLAKE_PREFLIGHT_CLICKHOUSE_V2_IMAGE
unset ASKLAKE_PREFLIGHT_KAFKA_CONNECT_V2_IMAGE

if (( compose_wiring_status != 0 )); then
  printf 'error: Compose wiring does not match the selected %s provider and feature-profile contract\n' "$storage_provider" >&2
  exit 1
fi

printf 'Deployment environment preflight passed for %s\n' "$app_domain"
