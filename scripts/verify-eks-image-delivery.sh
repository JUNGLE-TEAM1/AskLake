#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT_DIR/infra/eks/delivery/image-receipt.example.json"

node --check "$ROOT_DIR/scripts/create-eks-image-receipt.mjs"
node --check "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$EXAMPLE"

grep -q '^  workflow_dispatch:' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q '^  id-token: write$' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q -- '--platform linux/amd64' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q -- '--push frontend' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q -- '--push backend' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'node scripts/verify-eks-image-receipt.mjs' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'mask-aws-account-id: true' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'timeout-minutes: 60' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'apache/airflow:3.3.0' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'trinodb/trino:482' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
grep -q 'const defaultApiBaseUrl = ""' "$ROOT_DIR/frontend/src/services/apiClient.ts"

if grep -q 'VITE_API_BASE_URL=' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"; then
  echo "EKS frontend image must not bake a public API hostname or /api prefix" >&2
  exit 1
fi

platform_count="$(grep -c -- '--platform linux/amd64' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml")"
if [[ "$platform_count" -ne 4 ]]; then
  echo "expected three AMD64 builds and one AMD64 mirror pull, found $platform_count platform declarations" >&2
  exit 1
fi

if grep -Eiq 'aws-access-key-id|aws-secret-access-key|:latest' \
  "$ROOT_DIR/.github/workflows/eks-image-delivery.yml" || \
  grep -Eq '^  (pull_request|push):' "$ROOT_DIR/.github/workflows/eks-image-delivery.yml"; then
  echo "EKS image workflow contains static credentials, mutable tags, or an automatic trigger" >&2
  exit 1
fi

echo "EKS image delivery contract verification passed."
