#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/eks-image-delivery.yml"
FRONTEND_API_FILES=(
  "$ROOT_DIR/frontend/src/services/apiClient.ts"
  "$ROOT_DIR/frontend/src/services/realtimeEvents.ts"
)

if grep -Eq 'https?://(localhost|127\.0\.0\.1)(:[0-9]+)?' "${FRONTEND_API_FILES[@]}"; then
  echo "EKS frontend API clients must default to the browser origin, not localhost" >&2
  exit 1
fi

if grep -Eq -- '--build-arg[ =]+VITE_API_BASE_URL' "$WORKFLOW"; then
  echo "EKS frontend image delivery must not bake an API origin into the image" >&2
  exit 1
fi

grep -Fq 'bash scripts/verify-eks-frontend-same-origin.sh' "$WORKFLOW"
grep -Fq 'baseUrl: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL)' \
  "$ROOT_DIR/frontend/src/services/apiClient.ts"
grep -Fq 'return resolveApiBaseUrl(environment.VITE_API_BASE_URL)' \
  "$ROOT_DIR/frontend/src/services/realtimeEvents.ts"

echo "EKS frontend same-origin contract verification passed."
