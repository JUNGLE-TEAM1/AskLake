#!/usr/bin/env bash
set -euo pipefail

: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"
: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
if [[ "${ASKLAKE_WEB_DESTROY_CONFIRM:-}" != "destroy-web-after-ingress" ]]; then
  echo "set ASKLAKE_WEB_DESTROY_CONFIRM=destroy-web-after-ingress after removing Phase 13 ingress" >&2
  exit 1
fi

for command in aws kubectl helm; do
  command -v "$command" >/dev/null 2>&1 || { echo "required command is missing: $command" >&2; exit 1; }
done

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ "$current_endpoint" == "$expected_endpoint" ]] || { echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2; exit 1; }

for ingress in asklake-frontend asklake-backend; do
  if kubectl get ingress "$ingress" -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1; then
    echo "remove Phase 13 ingress and wait for ALB cleanup before deleting web Services" >&2
    exit 1
  fi
done

helm uninstall asklake-web -n "$ASKLAKE_EKS_NAMESPACE" --wait
echo "Web workloads removed. Foundation ConfigMaps, Secrets and ServiceAccounts were not deleted."
