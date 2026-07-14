#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT="$ROOT_DIR/infra/eks/secrets/runtime-secret-contract.example.json"
TERRAFORM_DIR="$ROOT_DIR/infra/eks/terraform"
READY_CONTRACT="$(mktemp)"
trap 'rm -f "$READY_CONTRACT"' EXIT

node --check "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs"
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" "$CONTRACT"

if node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --ready "$CONTRACT" >/dev/null 2>&1; then
  echo "planning Secret contract unexpectedly passed the deploy readiness gate" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  contract.delivery = {
    mode: "workflow_sync",
    controllerReady: false,
    controllerOwner: null,
    rotationOwner: "service-team",
    sourcePrefix: "/asklake/dev/runtime",
  };
  fs.writeFileSync(process.argv[2], JSON.stringify(contract));
' "$CONTRACT" "$READY_CONTRACT"
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --ready "$READY_CONTRACT"

for key in \
  BOOTSTRAP_ADMIN_PASSWORD \
  AI_GATEWAY_SERVICE_TOKEN \
  AI_MCP_SERVICE_TOKEN \
  AI_CONTEXT_SIGNING_SECRET \
  TRINO_RESULT_CURSOR_SECRET \
  TRINO_QUERY_CONFIRMATION_SECRET \
  AIRFLOW_EXECUTION_API_TOKEN \
  AIRFLOW_INTERNAL_TOKEN \
  ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD \
  TRINO_ICEBERG_JDBC_PASSWORD; do
  grep -q "\"$key\"" "$CONTRACT"
  grep -q "\"$key\"" "$TERRAFORM_DIR/runtime-secret.tf"
done

if grep -ERq 'resource[[:space:]]+"(kubernetes_secret|aws_secretsmanager_secret_version)"|data[[:space:]]*=|stringData[[:space:]]*=' \
  "$TERRAFORM_DIR/runtime-secret"*.tf; then
  echo "runtime Secret Terraform must not persist or render Secret values" >&2
  exit 1
fi

grep -Eq 'values_in_state[[:space:]]*=[[:space:]]*false' "$TERRAFORM_DIR/runtime-secret-outputs.tf"
grep -Eq 'secret_delivery_mode[[:space:]]*=[[:space:]]*"disabled"' "$TERRAFORM_DIR/dev.tfvars.example"

echo "EKS runtime Secret contract verification passed."
