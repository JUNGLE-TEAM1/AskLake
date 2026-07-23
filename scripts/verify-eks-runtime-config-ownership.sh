#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/require-eks-image-receipt.sh"
MODE="${1:---audit}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"

[[ "$MODE" == "--audit" || "$MODE" == "--ready" ]] || {
  echo "usage: verify-eks-runtime-config-ownership.sh [--audit|--ready]" >&2
  exit 2
}
for command in git jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

RECEIPT="$(asklake_require_image_receipt "$ROOT_DIR")" || exit 1
CONFIG="$(mktemp)"
trap 'rm -f "$CONFIG"' EXIT
chmod 600 "$CONFIG"
kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json >"$CONFIG"
node "$ROOT_DIR/scripts/verify-eks-runtime-config-contract.mjs" "$MODE" "$CONFIG" "$RECEIPT"
