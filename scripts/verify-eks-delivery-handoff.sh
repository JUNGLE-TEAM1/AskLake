#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_PATH="${1:-$ROOT_DIR/infra/eks/delivery/dev.handoff.example.json}"
RUNTIME_SECRET_PATH="$ROOT_DIR/infra/eks/secrets/runtime-secret-contract.example.json"

node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" "$CONTRACT_PATH"
node "$ROOT_DIR/scripts/verify-eks-deploy-readiness.mjs" \
  --delivery "$CONTRACT_PATH" \
  --runtime-secrets "$RUNTIME_SECRET_PATH"
node "$ROOT_DIR/scripts/test-eks-deploy-readiness.mjs"

if node "$ROOT_DIR/scripts/verify-eks-delivery-handoff.mjs" --ready "$CONTRACT_PATH" >/dev/null 2>&1; then
  echo "planning example unexpectedly passed the deploy-ready gate" >&2
  exit 1
fi

if node "$ROOT_DIR/scripts/verify-eks-deploy-readiness.mjs" \
  --ready \
  --delivery "$CONTRACT_PATH" \
  --runtime-secrets "$RUNTIME_SECRET_PATH" >/dev/null 2>&1; then
  echo "planning examples unexpectedly passed the combined deploy-ready gate" >&2
  exit 1
fi

echo "EKS delivery planning contract passed; deploy-ready gate remains closed as expected."
