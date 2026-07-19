#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"

TEST_ID="$$-${RANDOM}"
RECEIPT="$ROOT_DIR/infra/eks/delivery/.receipt-test-$TEST_ID.image-receipt.json"
cleanup() { rm -f "$RECEIPT"; }
trap cleanup EXIT

if ASKLAKE_IMAGE_RECEIPT= asklake_require_image_receipt "$ROOT_DIR" >/dev/null 2>&1; then
  echo "receipt helper accepted a missing input" >&2
  exit 1
fi
if ASKLAKE_IMAGE_RECEIPT=infra/eks/delivery/image-receipt.example.json \
  asklake_require_image_receipt "$ROOT_DIR" >/dev/null 2>&1; then
  echo "receipt helper accepted a tracked input" >&2
  exit 1
fi

cp "$ROOT_DIR/infra/eks/delivery/image-receipt.example.json" "$RECEIPT"
chmod 644 "$RECEIPT"
if ASKLAKE_IMAGE_RECEIPT="$RECEIPT" asklake_require_image_receipt "$ROOT_DIR" >/dev/null 2>&1; then
  echo "receipt helper accepted an unsafe file mode" >&2
  exit 1
fi

chmod 600 "$RECEIPT"
ASKLAKE_IMAGE_RECEIPT="$RECEIPT" asklake_require_image_receipt "$ROOT_DIR" >/dev/null
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" --require-ai-gateway "$RECEIPT" >/dev/null

jq '.contractVersion="1.0" | del(.images.aiGateway)' "$RECEIPT" >"$RECEIPT.tmp"
mv "$RECEIPT.tmp" "$RECEIPT"
chmod 600 "$RECEIPT"
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null
if node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" --require-ai-gateway "$RECEIPT" >/dev/null 2>&1; then
  echo "Gateway deployment accepted a legacy receipt" >&2
  exit 1
fi

jq '.images.aiGateway=.images.backend' "$RECEIPT" >"$RECEIPT.tmp"
mv "$RECEIPT.tmp" "$RECEIPT"
if node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT" >/dev/null 2>&1; then
  echo "legacy receipt accepted an unapproved AI Gateway image" >&2
  exit 1
fi

printf '{"contractVersion":"broken"}\n' >"$RECEIPT"
if ASKLAKE_IMAGE_RECEIPT="$RECEIPT" asklake_require_image_receipt "$ROOT_DIR" >/dev/null 2>&1; then
  echo "receipt helper accepted a malformed receipt" >&2
  exit 1
fi

if rg -q 'dev-8d4414df\.image-receipt\.json' \
  "$ROOT_DIR/scripts/prepare-eks-day16-a-handoff.sh" \
  "$ROOT_DIR/scripts/prepare-eks-day16-trino-values.sh" \
  "$ROOT_DIR/scripts/verify-eks-day16-trino-values.sh" \
  "$ROOT_DIR/scripts/run-eks-day16-trino-data-plane-smoke.sh" \
  "$ROOT_DIR/scripts/verify-eks-day16-a-handoff.sh" \
  "$ROOT_DIR/scripts/promote-eks-day16-a-handoff.sh"; then
  echo "a Day 16 workflow still embeds a historical receipt path" >&2
  exit 1
fi

echo "EKS image receipt input tests passed."
