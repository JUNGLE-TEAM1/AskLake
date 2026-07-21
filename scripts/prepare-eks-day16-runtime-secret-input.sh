#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
OUTPUT="${ASKLAKE_DAY16_SECRET_INPUT:-$ROOT_DIR/infra/eks/secrets/dev.runtime-secret-input.json}"
RDS_SECRET="${ASKLAKE_RDS_APPLICATION_SECRET:-asklake/dev/rds/application-databases}"

fail() {
  echo "$1" >&2
  exit 1
}

trap 'echo "private runtime Secret input preparation failed at line $LINENO" >&2' ERR

for command in aws htpasswd jq node openssl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

KEYTOOL_IMAGE="${ASKLAKE_KEYTOOL_IMAGE:-eclipse-temurin@sha256:9d8dcf999b0bce2453e913823595a5ff2a4e8e9e5d5241b45280d0ff069818ec}"
keytool_mode="native"
if ! command -v keytool >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || fail "a working Java keytool or Docker is required"
  keytool_mode="docker"
fi

if [[ -e "$OUTPUT" ]]; then
  node "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs" "$OUTPUT"
  echo "private_input_state=existing_valid"
  exit 0
fi

mkdir -p "$(dirname "$OUTPUT")"
temporary_directory="$(mktemp -d)"
temporary_output="$(mktemp "$(dirname "$OUTPUT")/.day16-runtime-secret-input.XXXXXX")"
cleanup() {
  rm -rf "$temporary_directory"
  rm -f "$temporary_output"
}
trap cleanup EXIT

rds_addresses="$(aws rds describe-db-instances --region "$REGION" --output json | jq -r '
  [.DBInstances[] | select(.DBInstanceStatus == "available") | .Endpoint.Address] | unique[]
')"
rds_count="$(awk 'NF { count += 1 } END { print count + 0 }' <<<"$rds_addresses")"
[[ "$rds_count" -eq 1 ]] || fail "exactly one available dev RDS endpoint is required"
rds_host="$rds_addresses"

application_passwords="$(aws secretsmanager get-secret-value \
  --region "$REGION" --secret-id "$RDS_SECRET" --query SecretString --output text)"
iceberg_password="$(jq -er '
  if (keys | sort) == ["airflow_app_password", "asklake_app_password", "iceberg_catalog_password"]
    and (.iceberg_catalog_password | type == "string" and length >= 16)
  then .iceberg_catalog_password else error("invalid application database credential contract") end
' <<<"$application_passwords")"
unset application_passwords

random_secret() {
  openssl rand -base64 48 | tr -d '\n'
}

query_password="$(random_secret)"
materializer_password="$(random_secret)"
cursor_secret="$(random_secret)"
confirmation_secret="$(random_secret)"
keystore_password="$(random_secret)"
internal_shared_secret="$(random_secret)"

keystore_file="$temporary_directory/trino-keystore.jks"
certificate_file="$temporary_directory/trino-ca.pem"
password_file="$temporary_directory/trino-password.db"

run_keytool() {
  if [[ "$keytool_mode" == "native" ]]; then
    keytool "$@"
  else
    docker run --rm -v "$temporary_directory:/work" "$KEYTOOL_IMAGE" keytool "$@"
  fi
}

if [[ "$keytool_mode" == "docker" ]]; then
  keytool_keystore="/work/trino-keystore.jks"
  keytool_certificate="/work/trino-ca.pem"
else
  keytool_keystore="$keystore_file"
  keytool_certificate="$certificate_file"
fi

run_keytool -genkeypair \
  -alias asklake-trino \
  -keyalg RSA -keysize 3072 -sigalg SHA256withRSA \
  -validity 825 -storetype JKS \
  -keystore "$keytool_keystore" \
  -storepass "$keystore_password" -keypass "$keystore_password" \
  -dname "CN=asklake-trino.asklake-dev.svc.cluster.local,OU=AskLake,O=AskLake,L=Seoul,C=KR" \
  -ext "SAN=dns:asklake-trino,dns:asklake-trino.asklake-dev,dns:asklake-trino.asklake-dev.svc,dns:asklake-trino.asklake-dev.svc.cluster.local" \
  -ext "KU=digitalSignature,keyEncipherment" \
  -ext "EKU=serverAuth" >/dev/null
run_keytool -exportcert -rfc \
  -alias asklake-trino -keystore "$keytool_keystore" \
  -storepass "$keystore_password" -file "$keytool_certificate" >/dev/null 2>&1

{
  htpasswd -nbBC 12 asklake-api "$query_password" | tr -d '\n'
  echo
  htpasswd -nbBC 12 asklake-materializer "$materializer_password" | tr -d '\n'
  echo
} >"$password_file"

certificate="$(cat "$certificate_file")"
keystore_base64="$(base64 <"$keystore_file" | tr -d '\n')"
password_database="$(<"$password_file")"
jdbc_url="jdbc:postgresql://${rds_host}:5432/iceberg_catalog"

jq -n \
  --arg jdbcUrl "$jdbc_url" \
  --arg jdbcPassword "$iceberg_password" \
  --arg queryPassword "$query_password" \
  --arg materializerPassword "$materializer_password" \
  --arg cursorSecret "$cursor_secret" \
  --arg confirmationSecret "$confirmation_secret" \
  --arg keystorePassword "$keystore_password" \
  --arg internalSharedSecret "$internal_shared_secret" \
  --arg certificate "$certificate" \
  --arg keystore "$keystore_base64" \
  --arg passwordDb "$password_database" '
  {
    contractVersion: "1.0",
    namespace: "asklake-dev",
    sources: {
      backendPatch: {
        TRINO_AUTH_USERNAME: "asklake-api",
        TRINO_AUTH_PASSWORD: $queryPassword,
        TRINO_MATERIALIZER_USERNAME: "asklake-materializer",
        TRINO_MATERIALIZER_PASSWORD: $materializerPassword,
        TRINO_RESULT_CURSOR_SECRET: $cursorSecret,
        TRINO_QUERY_CONFIRMATION_SECRET: $confirmationSecret,
        "trino-ca.pem": ($certificate + "\n")
      },
      spark: {
        ASKLAKE_SPARK_ICEBERG_JDBC_URL: $jdbcUrl,
        ASKLAKE_SPARK_ICEBERG_JDBC_USER: "iceberg_catalog",
        ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD: $jdbcPassword
      },
      trino: {
        TRINO_ICEBERG_JDBC_URL: $jdbcUrl,
        TRINO_ICEBERG_JDBC_USER: "iceberg_catalog",
        TRINO_ICEBERG_JDBC_PASSWORD: $jdbcPassword,
        TRINO_TLS_KEYSTORE_PASSWORD: $keystorePassword,
        TRINO_INTERNAL_SHARED_SECRET: $internalSharedSecret,
        "trino-keystore.jks": $keystore,
        "trino-password.db": $passwordDb
      }
    }
  }
  ' >"$temporary_output"
chmod 600 "$temporary_output"
node "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs" "$temporary_output"
mv "$temporary_output" "$OUTPUT"
chmod 600 "$OUTPUT"

unset iceberg_password query_password materializer_password cursor_secret confirmation_secret
unset keystore_password internal_shared_secret certificate keystore_base64 password_database
echo "private_input_state=created_valid"
