#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES_FILE="$ROOT_DIR/infra/eks/values/operators/spark-operator.dev.yaml"
CHART_REPOSITORY="https://kubeflow.github.io/spark-operator"
CHART_REFERENCE="spark-operator/spark-operator"
CHART_VERSION="2.5.1"
RELEASE_NAME="asklake-spark-operator"
OPERATOR_NAMESPACE="spark-operator"
JOB_NAMESPACE="asklake-dev"

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
if [[ "${ASKLAKE_SPARK_OPERATOR_APPLY_CONFIRM:-}" != "install-spark-operator-2.5.1" ]]; then
  echo "set ASKLAKE_SPARK_OPERATOR_APPLY_CONFIRM=install-spark-operator-2.5.1 after version and cost review" >&2
  exit 1
fi

for command in aws kubectl helm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

bash "$ROOT_DIR/scripts/verify-eks-spark-operator.sh"

expected_endpoint="$(aws eks describe-cluster --name "$ASKLAKE_EKS_CLUSTER_NAME" --query 'cluster.endpoint' --output text)"
current_endpoint="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [[ "$expected_endpoint" != "$current_endpoint" ]]; then
  echo "kubectl context does not match ASKLAKE_EKS_CLUSTER_NAME" >&2
  exit 1
fi

kubectl get namespace "$JOB_NAMESPACE" >/dev/null
spark_token="$(kubectl get serviceaccount asklake-spark -n "$JOB_NAMESPACE" -o jsonpath='{.automountServiceAccountToken}')"
if [[ "$spark_token" != "true" ]]; then
  echo "asklake-spark ServiceAccount token must be enabled before installing the operator" >&2
  exit 1
fi
kubectl get role asklake-spark-driver -n "$JOB_NAMESPACE" >/dev/null

if ! helm status "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" >/dev/null 2>&1 && \
   kubectl get crd sparkapplications.sparkoperator.k8s.io >/dev/null 2>&1; then
  echo "SparkApplication CRD exists without the expected Helm release; review shared ownership first" >&2
  exit 1
fi

helm repo add --force-update spark-operator "$CHART_REPOSITORY" >/dev/null
helm repo update spark-operator >/dev/null

helm upgrade --install "$RELEASE_NAME" "$CHART_REFERENCE" \
  --version "$CHART_VERSION" \
  --namespace "$OPERATOR_NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  --dry-run=server >/dev/null

helm upgrade --install "$RELEASE_NAME" "$CHART_REFERENCE" \
  --version "$CHART_VERSION" \
  --namespace "$OPERATOR_NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  --rollback-on-failure \
  --wait \
  --timeout 10m

kubectl wait --for=condition=Established crd/sparkapplications.sparkoperator.k8s.io --timeout=2m
kubectl wait --for=condition=Available deployment/asklake-spark-operator-controller -n "$OPERATOR_NAMESPACE" --timeout=5m
kubectl wait --for=condition=Available deployment/asklake-spark-operator-webhook -n "$OPERATOR_NAMESPACE" --timeout=5m

if [[ "$(kubectl get sparkapplications -n "$JOB_NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')" -ne 0 ]]; then
  echo "operator installation unexpectedly found or created a SparkApplication" >&2
  exit 1
fi

kubectl auth can-i create sparkapplications.sparkoperator.k8s.io \
  --namespace "$JOB_NAMESPACE" \
  --as="system:serviceaccount:$JOB_NAMESPACE:asklake-backend"

echo "Spark Operator $CHART_VERSION is ready and restricted to $JOB_NAMESPACE. No SparkApplication was submitted."
