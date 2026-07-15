#!/usr/bin/env bash
set -euo pipefail

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
: "${ASKLAKE_EKS_NAMESPACE:?ASKLAKE_EKS_NAMESPACE is required}"

if [[ "${ASKLAKE_INGRESS_DESTROY_CONFIRM:-}" != "delete-auto-mode-alb-before-cluster" ]]; then
  echo "set ASKLAKE_INGRESS_DESTROY_CONFIRM=delete-auto-mode-alb-before-cluster after rollback approval" >&2
  exit 1
fi

if [[ "${ASKLAKE_INGRESS_DNS_REMOVED_CONFIRM:-}" != "dns-record-removed-or-not-created" ]]; then
  echo "remove the DNS record first, then set ASKLAKE_INGRESS_DNS_REMOVED_CONFIRM=dns-record-removed-or-not-created" >&2
  exit 1
fi

for command in aws kubectl helm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

expected_cluster_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_cluster_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$current_cluster_endpoint" != "$expected_cluster_endpoint" ]]; then
  echo "kubectl cluster endpoint does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
fi

kubectl delete ingress asklake-backend asklake-frontend \
  --namespace "$ASKLAKE_EKS_NAMESPACE" \
  --ignore-not-found \
  --wait=true \
  --timeout=10m

if kubectl get ingress asklake-backend -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1 || \
   kubectl get ingress asklake-frontend -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1; then
  echo "Ingress deletion did not complete; do not destroy the cluster" >&2
  exit 1
fi

if helm status asklake-ingress -n "$ASKLAKE_EKS_NAMESPACE" >/dev/null 2>&1; then
  helm uninstall asklake-ingress -n "$ASKLAKE_EKS_NAMESPACE" --wait --timeout 5m
fi

echo "Ingress resources are deleted. Confirm the AWS ALB, target groups and security groups are gone before destroying EKS/VPC."
