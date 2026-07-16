#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/eks-backend-runtime-profile.sh"
TERRAFORM_DIR="$ROOT_DIR/infra/eks/terraform"
DEV_EXTERNAL_SECRETS="$ROOT_DIR/infra/eks/secrets/runtime-externalsecrets.dev.yaml"
BACKEND_EXTERNAL_SECRET="$ROOT_DIR/infra/eks/secrets/backend-runtime-external-secret.yaml"
TRINO_EXTERNAL_SECRET="$ROOT_DIR/infra/eks/secrets/trino-runtime-external-secret.yaml"
node --check "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs"
node --check "$ROOT_DIR/scripts/test-eks-runtime-secrets.mjs"
node "$ROOT_DIR/scripts/test-eks-runtime-secrets.mjs"
node --check "$ROOT_DIR/scripts/lib/validate-trino-password-db.mjs"
node "$ROOT_DIR/scripts/test-trino-password-db.mjs"

if grep -ERq 'resource[[:space:]]+"(kubernetes_secret|aws_secretsmanager_secret_version)"|data[[:space:]]*=|stringData[[:space:]]*=' \
  "$TERRAFORM_DIR/runtime-secret"*.tf; then
  echo "runtime Secret Terraform must not persist or render Secret values" >&2
  exit 1
fi

grep -Eq 'values_in_state[[:space:]]*=[[:space:]]*false' "$TERRAFORM_DIR/runtime-secret-outputs.tf"
grep -Eq 'secret_delivery_mode[[:space:]]*=[[:space:]]*"disabled"' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'jsondecode(file(' "$TERRAFORM_DIR/runtime-secret.tf"

if grep -Eq '^kind: Secret$|^[[:space:]]*stringData:|^[[:space:]]*value:' "$DEV_EXTERNAL_SECRETS"; then
  echo "dev ExternalSecret manifest must map remote properties without embedding Secret values" >&2
  exit 1
fi

test "$(grep -c '^kind: ExternalSecret$' "$DEV_EXTERNAL_SECRETS")" -eq 4
for name in \
  asklake-backend-runtime \
  asklake-airflow-runtime \
  asklake-spark-runtime \
  asklake-trino-runtime; do
  grep -q "^  name: $name$" "$DEV_EXTERNAL_SECRETS"
done
for source in \
  asklake/dev/backend/runtime \
  asklake/dev/airflow/runtime \
  asklake/dev/spark/runtime \
  asklake/dev/trino/runtime; do
  grep -q "^        key: $source$" "$DEV_EXTERNAL_SECRETS"
done
for key in \
  DATABASE_URL \
  BOOTSTRAP_ADMIN_PASSWORD \
  AIRFLOW_PASSWORD \
  AIRFLOW_EXECUTION_API_TOKEN \
  AIRFLOW_INTERNAL_TOKEN \
  AIRFLOW__DATABASE__SQL_ALCHEMY_CONN \
  AIRFLOW__CORE__FERNET_KEY \
  AIRFLOW__API_AUTH__JWT_SECRET \
  TRINO_AUTH_USERNAME \
  TRINO_AUTH_PASSWORD \
  TRINO_MATERIALIZER_USERNAME \
  TRINO_MATERIALIZER_PASSWORD \
  TRINO_RESULT_CURSOR_SECRET \
  TRINO_QUERY_CONFIRMATION_SECRET \
  trino-ca.pem \
  ASKLAKE_SPARK_ICEBERG_JDBC_URL \
  ASKLAKE_SPARK_ICEBERG_JDBC_USER \
  ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD \
  TRINO_ICEBERG_JDBC_URL \
  TRINO_ICEBERG_JDBC_USER \
  TRINO_ICEBERG_JDBC_PASSWORD \
  TRINO_TLS_KEYSTORE_PASSWORD \
  TRINO_INTERNAL_SHARED_SECRET \
  trino-keystore.jks \
  trino-password.db; do
  grep -q "^    - secretKey: $key$" "$DEV_EXTERNAL_SECRETS"
  grep -q "^        property: $key$" "$DEV_EXTERNAL_SECRETS"
done

expected_backend_keys="$(asklake_backend_runtime_profile "$ROOT_DIR" bounded)"
manifest_backend_keys="$(awk '$1 == "-" && $2 == "secretKey:" { print $3 }' "$BACKEND_EXTERNAL_SECRET" \
  | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')"
[[ "$manifest_backend_keys" == "$expected_backend_keys" ]] || {
  echo "Backend ExternalSecret differs from the bounded runtime profile" >&2
  exit 1
}

test "$(grep -c 'decodingStrategy: Base64' "$TRINO_EXTERNAL_SECRET")" -eq 1
test "$(grep -c 'decodingStrategy: Base64' "$DEV_EXTERNAL_SECRETS")" -eq 1
awk '
  $0 ~ /secretKey: trino-password.db/ { in_password = 1; next }
  in_password && $0 ~ /secretKey:/ { in_password = 0 }
  in_password && $0 ~ /decodingStrategy:/ { exit 1 }
' "$TRINO_EXTERNAL_SECRET" "$DEV_EXTERNAL_SECRETS" || {
  echo "Trino password database must be delivered as plaintext SecretString data" >&2
  exit 1
}

echo "EKS runtime Secret contract verification passed."
