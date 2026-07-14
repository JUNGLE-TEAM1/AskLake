#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY_SCRIPT="$ROOT_DIR/scripts/verify-deploy-env.sh"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy.sh"
VALID_COMPOSE="$ROOT_DIR/tests/deploy/fixtures/docker-compose.minio-separated.yml"
UNSAFE_COMPOSE="$ROOT_DIR/tests/deploy/fixtures/docker-compose.minio-app-as-root.yml"

TMP_PARENT="${TMPDIR:-/tmp}"
TMP_PARENT="${TMP_PARENT%/}"
TMP_DIR="$(mktemp -d "$TMP_PARENT/asklake-deploy-regression.XXXXXX")"
ENV_FILE="$TMP_DIR/deploy.env"
SPARK_DATA_DIR="$TMP_DIR/spark-data"
REPLAY_INPUT_DIR="$TMP_DIR/replay-input"
TRINO_CA_FILE="$TMP_DIR/trino-ca.pem"
TRINO_KEYSTORE_FILE="$TMP_DIR/trino-keystore.jks"
TRINO_PASSWORD_FILE="$TMP_DIR/trino-password.db"
SECRET_SENTINEL="MinioAppSecret_DO_NOT_PRINT_7uQ"

pass_count=0
fail_count=0
skip_count=0

cleanup() {
  case "$TMP_DIR" in
    "$TMP_PARENT"/asklake-deploy-regression.*)
      rm -rf -- "$TMP_DIR"
      ;;
    *)
      printf 'error: refusing to remove unexpected test directory\n' >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT

record_pass() {
  pass_count=$((pass_count + 1))
  printf 'ok - %s\n' "$1"
}

record_fail() {
  fail_count=$((fail_count + 1))
  printf 'not ok - %s\n' "$1" >&2
}

record_skip() {
  skip_count=$((skip_count + 1))
  printf 'ok - %s # SKIP %s\n' "$1" "$2"
}

write_valid_env() {
  local target="$1"
  {
    printf '%s\n' \
      'APP_ENV=production' \
      'ASKLAKE_OBJECT_STORAGE_PROVIDER=minio' \
      'APP_DOMAIN=deploy.asklake.test' \
      'VITE_API_BASE_URL=https://deploy.asklake.test' \
      'BACKEND_CORS_ORIGINS=https://deploy.asklake.test' \
      'AIRFLOW_API_AUTH_JWT_SECRET=AirflowJwtSecret_123' \
      'AIRFLOW_EXECUTION_API_TOKEN=AirflowExecutionToken_123' \
      'AIRFLOW_FERNET_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' \
      'AIRFLOW_INTERNAL_TOKEN=AirflowInternalToken_123' \
      'AIRFLOW_METADATA_DB_PASSWORD=AirflowMetadataDbPassword_123' \
      'AIRFLOW_PASSWORD=AirflowLoginPassword_123' \
      'BOOTSTRAP_ADMIN_EMAIL=admin@asklake.test' \
      'BOOTSTRAP_ADMIN_PASSWORD=BootstrapPassword_123' \
      'MINIO_ROOT_USER=MinioRootUser_123' \
      'MINIO_ROOT_PASSWORD=MinioRootPassword_123' \
      'MINIO_ACCESS_KEY=MinioApplicationUser_123' \
      "MINIO_SECRET_KEY=$SECRET_SENTINEL" \
      'MONGO_INITDB_ROOT_PASSWORD=MongoPassword_123' \
      'MONGO_INITDB_ROOT_USERNAME=MongoRootUser_123' \
      'POSTGRES_DB=asklake_metadata' \
      'POSTGRES_PASSWORD=PostgresPassword_123' \
      'POSTGRES_USER=asklake' \
      'ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW=100' \
      'ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS=900' \
      'ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS=30' \
      'ASKLAKE_PRODUCTION_SMOKE_RETRIES=12' \
      'ASKLAKE_PRODUCTION_SMOKE_RETRY_DELAY_SECONDS=5' \
      "ASKLAKE_HOST_DATA_DIR=$SPARK_DATA_DIR" \
      "ASKLAKE_REPLAY_HOST_INPUT_DIR=$REPLAY_INPUT_DIR"
  } > "$target"
}

write_valid_aws_env() {
  local target="$1"
  write_valid_env "$target"
  awk -F= '
    $1 ~ /^MINIO_(ROOT_USER|ROOT_PASSWORD|ACCESS_KEY|SECRET_KEY)$/ { next }
    $1 == "ASKLAKE_OBJECT_STORAGE_PROVIDER" { print "ASKLAKE_OBJECT_STORAGE_PROVIDER=aws"; next }
    { print }
  ' "$target" > "$target.next"
  mv "$target.next" "$target"
  {
    printf '%s\n' \
      'AWS_REGION=ap-northeast-2' \
      'ASKLAKE_RAW_BUCKET=asklake-test-raw' \
      'ASKLAKE_SPARK_OUTPUT_BUCKET=asklake-test-output' \
      'S3_ENDPOINT=' \
      'S3_FORCE_PATH_STYLE=false' \
      'S3_ALLOWED_BUCKETS=asklake-test-raw,asklake-test-output' \
      'ASKLAKE_S3_READINESS_READ_BUCKETS=asklake-test-raw' \
      'ASKLAKE_S3_READINESS_WRITE_BUCKETS=asklake-test-output'
  } >> "$target"
}

write_valid_trino_aws_env() {
  local target="$1"
  write_valid_aws_env "$target"
  replace_env_value \
    "$target" \
    ASKLAKE_S3_READINESS_WRITE_BUCKETS \
    'asklake-test-output,asklake-test-warehouse,asklake-test-query-results'
  {
    printf '%s\n' \
      'COMPOSE_PROFILES=trino' \
      'TRINO_ENABLED=true' \
      'TRINO_BASE_URL=https://trino:8443' \
      'TRINO_CATALOG=iceberg' \
      'TRINO_SCHEMA=asklake' \
      'TRINO_USER=asklake-api' \
      'TRINO_AUTH_USERNAME=asklake-api' \
      'TRINO_AUTH_PASSWORD=TrinoApiPassword_123' \
      'TRINO_MATERIALIZER_USERNAME=asklake-materializer' \
      'TRINO_MATERIALIZER_PASSWORD=TrinoMaterializerPassword_123' \
      'TRINO_RESULT_STORAGE_BUCKET=asklake-test-query-results' \
      'TRINO_RESULT_CURSOR_SECRET=TrinoResultCursorSecret_12345678901234567890' \
      'TRINO_QUERY_CONFIRMATION_SECRET=TrinoConfirmationSecret_12345678901234567890' \
      'TRINO_INTERNAL_SHARED_SECRET=TrinoInternalSharedSecret_12345678901234567890' \
      'TRINO_ICEBERG_JDBC_USER=asklake_trino' \
      'TRINO_ICEBERG_JDBC_PASSWORD=TrinoJdbcPassword_123' \
      'TRINO_ICEBERG_WAREHOUSE_BUCKET=asklake-test-warehouse' \
      'TRINO_TLS_KEYSTORE_PASSWORD=TrinoKeystorePassword_123' \
      "TRINO_TLS_CA_FILE=$TRINO_CA_FILE" \
      'TRINO_TLS_CA_CONTAINER_FILE=/run/secrets/trino-ca.pem' \
      "TRINO_TLS_KEYSTORE_FILE=$TRINO_KEYSTORE_FILE" \
      "TRINO_PASSWORD_FILE=$TRINO_PASSWORD_FILE"
  } >> "$target"
}

replace_env_value() {
  local target="$1"
  local key="$2"
  local value="$3"
  local replacement="$key=$value"

  awk -F= -v key="$key" -v replacement="$replacement" '
    $1 == key { print replacement; next }
    { print }
  ' "$target" > "$target.next"
  mv "$target.next" "$target"
}

run_preflight() {
  local compose_file="${1:-$VALID_COMPOSE}"
  bash "$VERIFY_SCRIPT" "$ENV_FILE" "$compose_file"
}

expect_preflight_pass() {
  local name="$1"
  local output

  if output="$(run_preflight 2>&1)"; then
    if [[ "$output" == *"$SECRET_SENTINEL"* ]]; then
      record_fail "$name (secret appeared in output)"
    else
      record_pass "$name"
    fi
  else
    record_fail "$name (unexpected failure)"
  fi
}

expect_preflight_failure() {
  local name="$1"
  local expected_message="$2"
  local compose_file="${3:-$VALID_COMPOSE}"
  local output

  if output="$(run_preflight "$compose_file" 2>&1)"; then
    record_fail "$name (unexpected success)"
    return
  fi
  if [[ "$output" == *"$SECRET_SENTINEL"* ]]; then
    record_fail "$name (secret appeared in output)"
    return
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    record_fail "$name (expected diagnostic was missing)"
    return
  fi
  record_pass "$name"
}

mkdir -p \
  "$SPARK_DATA_DIR/spark-ivy" \
  "$SPARK_DATA_DIR/spark-output" \
  "$SPARK_DATA_DIR/spark-runs" \
  "$SPARK_DATA_DIR/samples" \
  "$SPARK_DATA_DIR/review-text-models" \
  "$REPLAY_INPUT_DIR"
printf '%s\n' 'test certificate' > "$TRINO_CA_FILE"
printf '%s\n' 'test keystore' > "$TRINO_KEYSTORE_FILE"
printf '%s\n' 'asklake-api:test' 'asklake-materializer:test' > "$TRINO_PASSWORD_FILE"

write_valid_env "$ENV_FILE"
expect_preflight_pass 'valid production environment passes'

write_valid_aws_env "$ENV_FILE"
if output="$(run_preflight "$ROOT_DIR/deploy/docker-compose.prod.yml" 2>&1)"; then
  if [[ "$output" == *"$SECRET_SENTINEL"* ]]; then
    record_fail 'Trino-disabled production Compose does not require Iceberg variables (secret appeared in output)'
  else
    record_pass 'Trino-disabled production Compose does not require Iceberg variables'
  fi
else
  record_fail 'Trino-disabled production Compose does not require Iceberg variables (unexpected failure)'
fi

write_valid_trino_aws_env "$ENV_FILE"
if output="$(run_preflight "$ROOT_DIR/deploy/docker-compose.prod.yml" 2>&1)"; then
  record_pass 'Trino-enabled production Compose passes strict preflight'
else
  record_fail 'Trino-enabled production Compose passes strict preflight (unexpected failure)'
fi

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" COMPOSE_PROFILES ''
expect_preflight_failure \
  'Trino-enabled deployment requires its Compose profile' \
  'COMPOSE_PROFILES must include trino' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_aws_env "$ENV_FILE"
printf '%s\n' 'COMPOSE_PROFILES=trino' 'TRINO_ENABLED=false' >> "$ENV_FILE"
expect_preflight_failure \
  'Trino-disabled deployment rejects a stale Trino Compose profile' \
  'COMPOSE_PROFILES must not include trino' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" TRINO_AUTH_USERNAME 'renamed-api-user'
expect_preflight_failure \
  'Trino ACL identity drift is rejected' \
  'usernames must match the checked-in ACL' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" TRINO_TLS_CA_FILE "$TMP_DIR/missing-trino-ca.pem"
expect_preflight_failure \
  'Trino-enabled deployment requires readable TLS files' \
  'TRINO_TLS_CA_FILE file does not exist or is not readable' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_S3_READINESS_WRITE_BUCKETS 'asklake-test-output'
expect_preflight_failure \
  'Trino buckets must be covered by S3 readiness' \
  'ASKLAKE_S3_READINESS_WRITE_BUCKETS must include asklake-test-query-results' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW '0'
expect_preflight_failure \
  'Continuous publication window must be bounded' \
  'ASKLAKE_CONTINUOUS_PUBLICATION_WINDOW must be an integer between 1 and 1000' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS '3601'
expect_preflight_failure \
  'Continuous runner stale timeout must be bounded' \
  'ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS must be an integer between 10 and 3600' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_trino_aws_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_PRODUCTION_SMOKE_RETRIES '0'
expect_preflight_failure \
  'Production smoke retry count must be bounded' \
  'ASKLAKE_PRODUCTION_SMOKE_RETRIES must be an integer between 1 and 60' \
  "$ROOT_DIR/deploy/docker-compose.prod.yml"

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" AIRFLOW_FERNET_KEY ''
expect_preflight_failure 'blank Fernet key is rejected' 'AIRFLOW_FERNET_KEY must be set'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" AIRFLOW_FERNET_KEY 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA*='
expect_preflight_failure 'non-base64url Fernet key is rejected' 'canonical urlsafe base64'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" AIRFLOW_FERNET_KEY 'c2hvcnQ='
expect_preflight_failure 'wrong-length Fernet key is rejected' 'exactly 32 bytes'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" MINIO_ACCESS_KEY 'MinioRootUser_123'
expect_preflight_failure 'MinIO root and application access identities must differ' 'application credentials must be distinct'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" MINIO_SECRET_KEY 'MinioRootPassword_123'
expect_preflight_failure 'MinIO root and application secrets must differ' 'application credentials must be distinct'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" POSTGRES_PASSWORD 'unsafe@postgres'
expect_preflight_failure 'unsafe PostgreSQL URL password is rejected' 'POSTGRES_PASSWORD must use only the unpadded base64url alphabet'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" AIRFLOW_METADATA_DB_PASSWORD 'unsafe:airflow'
expect_preflight_failure 'unsafe Airflow DB URL password is rejected' 'AIRFLOW_METADATA_DB_PASSWORD must use only the unpadded base64url alphabet'

write_valid_env "$ENV_FILE"
printf '%s\n' 'POSTGRES_PASSWORD=DuplicatePassword_123' >> "$ENV_FILE"
expect_preflight_failure 'duplicate checked env keys are rejected' 'POSTGRES_PASSWORD must be defined exactly once'

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_HOST_DATA_DIR 'relative/spark-data'
expect_preflight_failure 'relative Spark data directory is rejected' 'ASKLAKE_HOST_DATA_DIR must be an absolute host directory path'

write_valid_env "$ENV_FILE"
rmdir "$SPARK_DATA_DIR/spark-runs"
expect_preflight_failure 'missing Spark data subdirectory is rejected' 'ASKLAKE_HOST_DATA_DIR/spark-runs directory does not exist'
mkdir -p "$SPARK_DATA_DIR/spark-runs"

write_valid_env "$ENV_FILE"
replace_env_value "$ENV_FILE" ASKLAKE_REPLAY_HOST_INPUT_DIR "$TMP_DIR/missing-replay-input"
expect_preflight_failure 'missing replay host directory is rejected' 'ASKLAKE_REPLAY_HOST_INPUT_DIR directory does not exist'

write_valid_env "$ENV_FILE"
expect_preflight_failure \
  'Compose wiring that reuses application credentials as root is rejected' \
  'Compose object-storage wiring does not match the selected minio provider contract' \
  "$UNSAFE_COMPOSE"

# Source without executing main so the real health_check function can be exercised
# with deterministic curl fixtures.
source "$DEPLOY_SCRIPT"

mock_ssm_transport() (
  DEPLOY_TRANSPORT=ssm
  ssm_run() { printf 'ssm:%s\n' "$1"; }
  ssh_run() { printf 'ssh:%s\n' "$1"; }
  remote_run 'printf smoke'
)

if output="$(mock_ssm_transport 2>&1)" && [[ "$output" == 'ssm:printf smoke' ]]; then
  record_pass 'SSM transport routes remote commands without SSH'
else
  record_fail 'SSM transport routes remote commands without SSH'
fi

mock_ssm_run() (
  EC2_INSTANCE_ID=i-ssmtest
  AWS_REGION=ap-northeast-2
  SSM_TIMEOUT_SECONDS=60
  SSM_POLL_INTERVAL_SECONDS=1
  aws() {
    case "$1 $2 $*" in
      'ssm send-command '*) printf 'command-123\n' ;;
      *"--query Status "*) printf 'Success\n' ;;
      *"--query StandardOutputContent "*) printf 'remote command completed\n' ;;
      *"--query StandardErrorContent "*) printf 'None\n' ;;
      *) return 1 ;;
    esac
  }
  ssm_run 'printf smoke'
)

if output="$(mock_ssm_run 2>&1)" \
  && [[ "$output" == *'Waiting for SSM command command-123...'* ]] \
  && [[ "$output" == *'remote command completed'* ]]; then
  record_pass 'SSM runner waits for and returns remote command output'
else
  record_fail 'SSM runner waits for and returns remote command output'
fi

mock_invalid_transport() (
  DEPLOY_TRANSPORT=invalid
  validate_deploy_transport
)

if output="$(mock_invalid_transport 2>&1)"; then
  record_fail 'deploy transport rejects unsupported values (unexpected success)'
elif [[ "$output" == *'ASKLAKE_DEPLOY_TRANSPORT must be ssh or ssm'* ]]; then
  record_pass 'deploy transport rejects unsupported values'
else
  record_fail 'deploy transport rejects unsupported values'
fi

mock_trino_deploy_control() (
  local enabled="$1"

  remote_trino_enabled() {
    printf '%s\n' "$enabled"
  }
  remote_compose() {
    printf 'compose:%s\n' "$1"
  }

  bootstrap_trino_dependencies
  verify_trino_runtime
)

if output="$(mock_trino_deploy_control false 2>&1)" \
  && [[ "$output" == *'compose:rm -sf trino-result-collector trino-result-cleanup trino trino-postgres-bootstrap'* ]] \
  && [[ "$output" != *'verify-trino-production-readiness.py'* ]]; then
  record_pass 'deploy control removes stale Trino services and skips readiness when disabled'
else
  record_fail 'deploy control removes stale Trino services and skips readiness when disabled'
fi

if output="$(mock_trino_deploy_control true 2>&1)" \
  && [[ "$output" == *'compose:up -d postgres'* ]] \
  && [[ "$output" == *'compose:run --rm trino-postgres-bootstrap'* ]] \
  && [[ "$output" == *'verify-trino-production-readiness.py'* ]] \
  && [[ "$output" != *'--allow-disabled'* ]]; then
  record_pass 'deploy control bootstraps and strictly verifies Trino when enabled'
else
  record_fail 'deploy control bootstraps and strictly verifies Trino when enabled'
fi

mock_runtime_smoke() (
  local enabled="$1"

  remote_trino_enabled() {
    printf '%s\n' "$enabled"
  }
  remote_compose() {
    printf 'compose:%s\n' "$1"
  }
  verify_production_runtime_smoke
)

if output="$(mock_runtime_smoke true 2>&1)" \
  && [[ "$output" == *'compose:exec -T backend python scripts/verify-production-runtime-smoke.py'* ]]; then
  record_pass 'explicit production runtime smoke runs inside the backend container'
else
  record_fail 'explicit production runtime smoke runs inside the backend container'
fi

if output="$(mock_runtime_smoke false 2>&1)"; then
  record_fail 'production runtime smoke rejects the Trino-disabled compatibility deployment (unexpected success)'
elif [[ "$output" == *'production runtime smoke requires TRINO_ENABLED=true'* ]]; then
  record_pass 'production runtime smoke rejects the Trino-disabled compatibility deployment'
else
  record_fail 'production runtime smoke rejects the Trino-disabled compatibility deployment'
fi

mock_runtime_smoke_prepare() (
  ensure_started() { printf 'prepare:ensure-started\n'; }
  remote_deploy_preflight() { printf 'prepare:preflight\n'; }
  bootstrap_trino_dependencies() { printf 'prepare:bootstrap\n'; }
  health_check() { printf 'prepare:health\n'; }
  verify_trino_runtime() { printf 'prepare:trino\n'; }
  prepare_production_runtime_smoke
)

if output="$(mock_runtime_smoke_prepare 2>&1)" \
  && [[ "$output" == $'prepare:ensure-started\nprepare:preflight\nprepare:bootstrap\nprepare:health\nprepare:trino' ]]; then
  record_pass 'standalone production runtime smoke uses deploy-equivalent preparation'
else
  record_fail 'standalone production runtime smoke uses deploy-equivalent preparation'
fi

mock_job_smoke() (
  ASKLAKE_RUN_PRODUCTION_JOB_E2E="${1:-false}"
  remote_compose() { printf 'compose:%s\n' "$1"; }
  verify_production_job_e2e
)

if output="$(mock_job_smoke true 2>&1)" \
  && [[ "$output" == *'compose:exec -T -e ASKLAKE_RUN_PRODUCTION_JOB_E2E=true backend python scripts/verify-production-job-e2e.py'* ]]; then
  record_pass 'opt-in production Job E2E smoke runs inside the backend container'
else
  record_fail 'opt-in production Job E2E smoke runs inside the backend container'
fi

if output="$(mock_job_smoke false 2>&1)"; then
  record_fail 'production Job E2E smoke requires explicit opt-in (unexpected success)'
elif [[ "$output" == *'job-smoke requires ASKLAKE_RUN_PRODUCTION_JOB_E2E=true'* ]]; then
  record_pass 'production Job E2E smoke requires explicit opt-in'
else
  record_fail 'production Job E2E smoke requires explicit opt-in'
fi

mock_health_check() (
  local payload="$1"

  HEALTH_RETRIES=1
  HEALTH_RETRY_DELAY=0
  HEALTH_PATH=/api/health

  resolve_app_url() {
    printf 'https://deploy.asklake.test\n'
  }

  curl() {
    if [[ " $* " == *' -fsSI '* ]]; then
      return 0
    fi
    printf '%s' "$payload"
  }

  sleep() {
    :
  }

  health_check
)

expect_health_pass() {
  local name="$1"
  local payload="$2"
  local output

  if output="$(mock_health_check "$payload" 2>&1)"; then
    if [[ "$output" == *"$SECRET_SENTINEL"* ]]; then
      record_fail "$name (health body appeared in output)"
    else
      record_pass "$name"
    fi
  else
    record_fail "$name (unexpected failure)"
  fi
}

expect_health_failure() {
  local name="$1"
  local payload="$2"
  local output

  if output="$(mock_health_check "$payload" 2>&1)"; then
    record_fail "$name (unexpected success)"
    return
  fi
  if [[ "$output" == *"$SECRET_SENTINEL"* ]]; then
    record_fail "$name (health body appeared in output)"
    return
  fi
  if [[ "$output" != *'.ok=true and .database.ok=true'* ]]; then
    record_fail "$name (readiness diagnostic was missing)"
    return
  fi
  record_pass "$name"
}

expect_health_pass \
  'health accepts exact top-level and database readiness booleans' \
  "{\"ok\":true,\"database\":{\"ok\":true},\"detail\":\"$SECRET_SENTINEL\"}"
expect_health_failure \
  'health rejects a false top-level readiness flag' \
  '{"ok":false,"database":{"ok":true}}'
expect_health_failure \
  'health rejects a false database readiness flag' \
  '{"ok":true,"database":{"ok":false}}'
expect_health_failure \
  'health rejects string lookalikes instead of JSON booleans' \
  '{"ok":"true","database":{"ok":"true"}}'
expect_health_failure \
  'health rejects a missing database readiness object' \
  '{"ok":true}'
expect_health_failure \
  'health rejects numeric truthy readiness values' \
  '{"ok":1,"database":{"ok":1}}'
expect_health_failure \
  'health rejects malformed JSON without echoing it' \
  "$SECRET_SENTINEL"

printf 'deploy regression summary: %s passed, %s failed, %s skipped\n' \
  "$pass_count" "$fail_count" "$skip_count"

(( fail_count == 0 ))
