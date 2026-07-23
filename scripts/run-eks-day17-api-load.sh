#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
RATE="${ASKLAKE_DAY17_LOAD_RATE:-50}"
DURATION="${ASKLAKE_DAY17_LOAD_DURATION_SECONDS:-60}"
PHASE="${ASKLAKE_DAY17_LOAD_PHASE:-probe-${RATE}}"
STATUS_PATH="${ASKLAKE_DAY17_LOAD_STATUS_PATH:-/private/tmp/asklake-day17-load-status.json}"

[[ "${ASKLAKE_DAY17_LOAD_CONFIRM:-}" == "run-read-only-api-load" ]] || {
  echo "set ASKLAKE_DAY17_LOAD_CONFIRM=run-read-only-api-load" >&2
  exit 2
}
[[ "$RATE" =~ ^(50|100|200)$ ]] || {
  echo "ASKLAKE_DAY17_LOAD_RATE must be 50, 100, or 200" >&2
  exit 2
}
[[ "$DURATION" =~ ^[0-9]+$ && "$DURATION" -ge 1 && "$DURATION" -le 600 ]] || {
  echo "ASKLAKE_DAY17_LOAD_DURATION_SECONDS must be 1..600" >&2
  exit 2
}
[[ "$STATUS_PATH" == /* ]] || {
  echo "ASKLAKE_DAY17_LOAD_STATUS_PATH must be absolute" >&2
  exit 2
}

for command in aws curl jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done

if [[ -z "${ASKLAKE_EKS_CLUSTER_NAME:-}" ]]; then
  clusters_json="$(aws eks list-clusters \
    --region "${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}" \
    --output json)"
  [[ "$(jq '.clusters | length' <<<"$clusters_json")" -eq 1 ]] || {
    echo "ASKLAKE_EKS_CLUSTER_NAME is required when the account exposes zero or multiple clusters" >&2
    exit 1
  }
  export ASKLAKE_EKS_CLUSTER_NAME="$(jq -r '.clusters[0]' <<<"$clusters_json")"
fi

verify_asklake_eks_context
bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null

backend_host="$(
  kubectl get ingress asklake-backend -n "$NAMESPACE" -o json \
    | jq -r '.status.loadBalancer.ingress[0].hostname // ""'
)"
[[ "$backend_host" =~ ^[a-zA-Z0-9.-]+$ ]] || {
  echo "Backend ALB address is unavailable or invalid" >&2
  exit 1
}

export ASKLAKE_DAY17_LOAD_URL="http://${backend_host}/api/health"
exec node "$ROOT_DIR/scripts/run-eks-day17-api-load.mjs" \
  --rate "$RATE" \
  --duration "$DURATION" \
  --concurrency 64 \
  --timeout-ms 5000 \
  --phase "$PHASE" \
  --status "$STATUS_PATH"
