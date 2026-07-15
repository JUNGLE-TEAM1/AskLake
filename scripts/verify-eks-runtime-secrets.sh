#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="$ROOT_DIR/infra/eks/terraform"
node --check "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs"
node --check "$ROOT_DIR/scripts/test-eks-runtime-secrets.mjs"
node "$ROOT_DIR/scripts/test-eks-runtime-secrets.mjs"

if grep -ERq 'resource[[:space:]]+"(kubernetes_secret|aws_secretsmanager_secret_version)"|data[[:space:]]*=|stringData[[:space:]]*=' \
  "$TERRAFORM_DIR/runtime-secret"*.tf; then
  echo "runtime Secret Terraform must not persist or render Secret values" >&2
  exit 1
fi

grep -Eq 'values_in_state[[:space:]]*=[[:space:]]*false' "$TERRAFORM_DIR/runtime-secret-outputs.tf"
grep -Eq 'secret_delivery_mode[[:space:]]*=[[:space:]]*"disabled"' "$TERRAFORM_DIR/dev.tfvars.example"
grep -q 'jsondecode(file(' "$TERRAFORM_DIR/runtime-secret.tf"

echo "EKS runtime Secret contract verification passed."
