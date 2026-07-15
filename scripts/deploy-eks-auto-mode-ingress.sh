#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-ingress"
MODE="${1:-}"
VALUES_FILE="${2:-}"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE"' EXIT

usage() {
  echo "usage: $0 --render|--apply <private-values.yaml>" >&2
}

if [[ ! "$MODE" =~ ^--(render|apply)$ ]] || [[ -z "$VALUES_FILE" ]] || [[ ! -s "$VALUES_FILE" ]]; then
  usage
  exit 2
fi

bash "$ROOT_DIR/scripts/verify-eks-network-ingress.sh" >&2
helm lint "$CHART_DIR" -f "$VALUES_FILE" >&2
helm template asklake-ingress "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

for required_kind in IngressClassParams IngressClass Ingress; do
  if ! grep -q "^kind: $required_kind$" "$RENDERED_FILE"; then
    echo "deployment values did not render required kind: $required_kind" >&2
    exit 1
  fi
done

if [[ "$MODE" == "--render" ]]; then
  cat "$RENDERED_FILE"
  exit 0
fi

VALUES_DIR="$(cd "$(dirname "$VALUES_FILE")" && pwd)"
VALUES_BASENAME="$(basename "$VALUES_FILE")"
VALUES_ABSOLUTE="$VALUES_DIR/$VALUES_BASENAME"
case "$VALUES_ABSOLUTE" in
  "$ROOT_DIR"/*)
    echo "repository values cannot be applied to AWS; use a reviewed file outside the repository" >&2
    exit 1
    ;;
esac

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"

if [[ "${ASKLAKE_INGRESS_APPLY_CONFIRM:-}" != "create-cost-bearing-auto-mode-alb" ]]; then
  echo "set ASKLAKE_INGRESS_APPLY_CONFIRM=create-cost-bearing-auto-mode-alb after plan and cost approval" >&2
  exit 1
fi

for command in aws kubectl helm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

auto_mode_lb_enabled="$(aws eks describe-cluster \
  --name "$ASKLAKE_EKS_CLUSTER_NAME" \
  --query 'cluster.kubernetesNetworkConfig.elasticLoadBalancing.enabled' \
  --output text)"
if [[ "$auto_mode_lb_enabled" != "True" && "$auto_mode_lb_enabled" != "true" ]]; then
  echo "target cluster does not report EKS Auto Mode load balancing enabled" >&2
  exit 1
fi

expected_cluster_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_cluster_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$current_cluster_endpoint" != "$expected_cluster_endpoint" ]]; then
  echo "kubectl cluster endpoint does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
fi

namespace_access="$(kubectl get namespace "$ASKLAKE_EKS_NAMESPACE" -o jsonpath='{.metadata.labels.asklake\.io/ingress-access}')"
if [[ "$namespace_access" != "$ASKLAKE_EKS_NAMESPACE" ]]; then
  echo "namespace is missing the exact asklake.io/ingress-access label" >&2
  exit 1
fi

rendered_namespaces="$(awk '/^  namespace:/ {print $2}' "$RENDERED_FILE" | sort -u)"
if [[ "$rendered_namespaces" != "$ASKLAKE_EKS_NAMESPACE" ]]; then
  echo "rendered Ingress namespace does not match ASKLAKE_EKS_NAMESPACE" >&2
  exit 1
fi
if ! grep -q "asklake.io/ingress-access: $ASKLAKE_EKS_NAMESPACE" "$RENDERED_FILE"; then
  echo "rendered IngressClassParams namespace selector does not match the target namespace" >&2
  exit 1
fi

if ! kubectl api-resources --api-group=eks.amazonaws.com --no-headers | awk '{print $1}' | grep -qx 'ingressclassparams'; then
  echo "target cluster does not expose EKS Auto Mode IngressClassParams" >&2
  exit 1
fi

kubectl get service frontend fastapi -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null
kubectl apply --server-side --dry-run=server -f "$RENDERED_FILE" >/dev/null

helm upgrade --install asklake-ingress "$CHART_DIR" \
  --namespace "$ASKLAKE_EKS_NAMESPACE" \
  --create-namespace=false \
  -f "$VALUES_FILE" \
  --atomic \
  --wait \
  --timeout 10m

kubectl get ingress asklake-backend asklake-frontend -n "$ASKLAKE_EKS_NAMESPACE"
echo "Ingress submitted. Record ALB hostname, HTTPS smoke, target health and cost evidence before declaring Phase 13 runtime-complete."
