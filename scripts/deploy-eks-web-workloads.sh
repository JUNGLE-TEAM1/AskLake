#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
MODE="${1:-}"
VALUES_FILE="${2:-}"
IMAGE_RECEIPT="${3:-}"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE"' EXIT

usage() {
  echo "usage: $0 --render|--apply <private-values.yaml> <image-receipt.json>" >&2
}

if [[ ! "$MODE" =~ ^--(render|apply)$ ]] || [[ ! -s "$VALUES_FILE" ]] || [[ ! -s "$IMAGE_RECEIPT" ]]; then
  usage
  exit 2
fi

bash "$ROOT_DIR/scripts/verify-eks-web-workloads.sh" >&2
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$IMAGE_RECEIPT" >&2
helm lint "$CHART_DIR" -f "$VALUES_FILE" >&2
helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

for component in frontend backend; do
  container_name="$component"
  [[ "$component" == "backend" ]] && container_name="fastapi"
  image="$(awk -v name="$container_name" '
    $1 == "-" && $2 == "name:" && $3 == name { in_container = 1; next }
    in_container && $1 == "image:" { gsub(/\"/, "", $2); print $2; exit }
  ' "$RENDERED_FILE")"
  if [[ -z "$image" ]] || ! node -e '
    const fs = require("fs");
    const [receiptPath, component, expected] = process.argv.slice(1);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    process.exit(receipt.images?.[component] === expected ? 0 : 1);
  ' "$IMAGE_RECEIPT" "$component" "$image"; then
    echo "rendered $component image does not match the verified image receipt" >&2
    exit 1
  fi
done

if [[ "$MODE" == "--render" ]]; then
  cat "$RENDERED_FILE"
  exit 0
fi

VALUES_ABSOLUTE="$(cd "$(dirname "$VALUES_FILE")" && pwd)/$(basename "$VALUES_FILE")"
case "$VALUES_ABSOLUTE" in
  "$ROOT_DIR"/*)
    echo "repository values cannot be applied to EKS; use a reviewed file outside the repository" >&2
    exit 1
    ;;
esac

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"
if [[ "${ASKLAKE_WEB_APPLY_CONFIRM:-}" != "deploy-reviewed-web-workloads" ]]; then
  echo "set ASKLAKE_WEB_APPLY_CONFIRM=deploy-reviewed-web-workloads after runtime and image approval" >&2
  exit 1
fi

for command in aws kubectl helm; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command is missing: $command" >&2; exit 1; }
done

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$current_endpoint" == "$expected_endpoint" ]] || { echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2; exit 1; }

rendered_namespaces="$(awk '/^  namespace:/ {print $2}' "$RENDERED_FILE" | sort -u)"
[[ "$rendered_namespaces" == "$ASKLAKE_EKS_NAMESPACE" ]] || { echo "rendered namespace does not match ASKLAKE_EKS_NAMESPACE" >&2; exit 1; }

kubectl get serviceaccount asklake-frontend asklake-backend -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null
kubectl get configmap asklake-runtime asklake-runtime-boundary -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null
kubectl get secret asklake-backend-runtime -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null
kubectl wait --for=condition=Ready node -l asklake.io/workload-class=general --timeout=30s >/dev/null || { echo "no Ready node has the General placement label" >&2; exit 1; }
kubectl apply --server-side --dry-run=server -f "$RENDERED_FILE" >/dev/null

helm upgrade --install asklake-web "$CHART_DIR" \
  --namespace "$ASKLAKE_EKS_NAMESPACE" --create-namespace=false \
  -f "$VALUES_FILE" --atomic --wait --timeout 10m

kubectl rollout status deployment/frontend deployment/fastapi -n "$ASKLAKE_EKS_NAMESPACE" --timeout=10m
echo "Web workloads are ready. Record replica distribution, restart recovery and /api/health evidence before applying Phase 13 ingress."
