#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-foundation"
VALUES_FILE="$ROOT_DIR/infra/eks/values/dev.example.yaml"
TERRAFORM_DIR="$ROOT_DIR/infra/eks/terraform"
RENDERED_FILE="$(mktemp)"
TERRAFORM_DATA_DIR="$(mktemp -d)"
trap 'rm -f "$RENDERED_FILE"; rm -rf "$TERRAFORM_DATA_DIR"' EXIT

required_files=(
  "$ROOT_DIR/infra/eks/README.md"
  "$TERRAFORM_DIR/main.tf"
  "$TERRAFORM_DIR/outputs.tf"
  "$TERRAFORM_DIR/dev.tfvars.example"
  "$CHART_DIR/Chart.yaml"
  "$CHART_DIR/values.schema.json"
  "$VALUES_FILE"
  "$ROOT_DIR/docs/eks-msk-mvp-phase-1-handoff.md"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing required EKS foundation file: $required_file" >&2
    exit 1
  fi
done

helm lint "$CHART_DIR" -f "$VALUES_FILE"
helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

if helm template asklake-foundation "$CHART_DIR" -f "$VALUES_FILE" \
  --set global.kafkaRuntime=redpanda >/dev/null 2>&1; then
  echo "Helm schema accepted a non-MSK deployment broker" >&2
  exit 1
fi

service_account_count="$(grep -c '^kind: ServiceAccount$' "$RENDERED_FILE")"
if [[ "$service_account_count" -ne 5 ]]; then
  echo "expected 5 workload service accounts, rendered $service_account_count" >&2
  exit 1
fi

for service_account in \
  asklake-frontend \
  asklake-backend \
  asklake-airflow \
  asklake-replay-producer \
  asklake-spark; do
  if ! grep -q "name: $service_account" "$RENDERED_FILE"; then
    echo "rendered foundation is missing service account: $service_account" >&2
    exit 1
  fi
done

grep -q 'kafkaRuntime: "msk-serverless"' "$RENDERED_FILE"
grep -q 'kafkaAuth: "iam"' "$RENDERED_FILE"
grep -q 'continuousOwner: "ec2-mvp"' "$RENDERED_FILE"

if grep -q '^kind: StatefulSet$' "$RENDERED_FILE"; then
  echo "EKS foundation must not deploy a Kafka/Redpanda StatefulSet" >&2
  exit 1
fi

if grep -Eiq '(AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' \
  "$TERRAFORM_DIR"/*.tf "$TERRAFORM_DIR/dev.tfvars.example" "$VALUES_FILE"; then
  echo "credential-like value found in EKS foundation examples" >&2
  exit 1
fi

TERRAFORM_BIN="${ASKLAKE_TERRAFORM_BIN:-}"
if [[ -z "$TERRAFORM_BIN" ]] && command -v terraform >/dev/null 2>&1; then
  TERRAFORM_BIN="$(command -v terraform)"
fi

if [[ -n "$TERRAFORM_BIN" ]]; then
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" fmt -check -recursive
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" init -backend=false -input=false >/dev/null
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" validate
  TF_DATA_DIR="$TERRAFORM_DATA_DIR" "$TERRAFORM_BIN" -chdir="$TERRAFORM_DIR" test
else
  echo "SKIP: terraform CLI is not installed; run the documented Docker validation before commit."
fi

echo "EKS foundation contract verification passed."
