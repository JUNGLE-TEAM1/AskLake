#!/usr/bin/env bash
set -euo pipefail

RELEASE_NAME="asklake-spark-operator"
OPERATOR_NAMESPACE="spark-operator"

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
if [[ "${ASKLAKE_SPARK_OPERATOR_DESTROY_CONFIRM:-}" != "delete-spark-operator-crds-after-empty-check" ]]; then
  echo "set ASKLAKE_SPARK_OPERATOR_DESTROY_CONFIRM=delete-spark-operator-crds-after-empty-check after confirming no SparkApplication must be retained" >&2
  exit 1
fi

for command in aws kubectl helm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$expected_endpoint" != "$current_endpoint" ]]; then
  echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
fi

application_count="$(kubectl get sparkapplications,scheduledsparkapplications -A --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$application_count" -ne 0 ]]; then
  echo "Spark applications still exist; delete or preserve them before removing the operator" >&2
  exit 1
fi

if helm status "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" >/dev/null 2>&1; then
  helm uninstall "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" --wait --timeout 5m
fi

kubectl delete crd \
  sparkapplications.sparkoperator.k8s.io \
  scheduledsparkapplications.sparkoperator.k8s.io \
  sparkconnects.sparkoperator.k8s.io \
  --ignore-not-found \
  --wait=true \
  --timeout=5m

kubectl delete namespace "$OPERATOR_NAMESPACE" --ignore-not-found --wait=true --timeout=5m
echo "Spark Operator release, empty CRDs and operator namespace were removed."
