#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES_FILE="$ROOT_DIR/infra/eks/values/operators/spark-operator.dev.yaml"
ADMISSION_FIXTURE="$ROOT_DIR/infra/eks/smoke/sparkapplication-admission.yaml"
CHART_REPOSITORY="https://kubeflow.github.io/spark-operator"
CHART_REFERENCE="spark-operator/spark-operator"
CHART_VERSION="2.5.1"
CHART_SHA256="835ca955f65e221c79f7ef3ac7ef9070c71d30ea7ed06f242c41fc56fe9e8f1f"
RELEASE_NAME="asklake-spark-operator"
OPERATOR_NAMESPACE="spark-operator"
JOB_NAMESPACE="asklake-dev"
OWNER="pair-a"
CRDS=(
  sparkapplications.sparkoperator.k8s.io
  scheduledsparkapplications.sparkoperator.k8s.io
  sparkconnects.sparkoperator.k8s.io
)
TEMP_DIR="$(mktemp -d)"
CHART_ARCHIVE="$TEMP_DIR/spark-operator-$CHART_VERSION.tgz"
trap 'rm -rf "$TEMP_DIR"' EXIT

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
if [[ "${ASKLAKE_SPARK_OPERATOR_APPLY_CONFIRM:-}" != "install-spark-operator-2.5.1" ]]; then
  echo "set ASKLAKE_SPARK_OPERATOR_APPLY_CONFIRM=install-spark-operator-2.5.1 after version and cost review" >&2
  exit 1
fi

for command in aws kubectl helm awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

resource_count() {
  local resource="$1"
  kubectl get "$resource" -A --no-headers 2>/dev/null | wc -l | tr -d ' '
}

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

for crd in "${CRDS[@]}"; do
  if kubectl get crd "$crd" >/dev/null 2>&1; then
    existing_owner="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/owner}')"
    existing_release="$(kubectl get crd "$crd" -o jsonpath='{.metadata.annotations.asklake\.io/release}')"
    if [[ -n "$existing_owner" && "$existing_owner" != "$OWNER" ]]; then
      echo "$crd is owned by $existing_owner; refusing to overwrite it" >&2
      exit 1
    fi
    if [[ -n "$existing_release" && "$existing_release" != "$RELEASE_NAME" ]]; then
      echo "$crd belongs to release $existing_release; refusing to overwrite it" >&2
      exit 1
    fi
  fi
done

if ! helm status "$RELEASE_NAME" -n "$OPERATOR_NAMESPACE" >/dev/null 2>&1 && \
   kubectl get crd sparkapplications.sparkoperator.k8s.io >/dev/null 2>&1; then
  existing_owner="$(kubectl get crd sparkapplications.sparkoperator.k8s.io -o jsonpath='{.metadata.annotations.asklake\.io/owner}')"
  if [[ "$existing_owner" != "$OWNER" ]]; then
    echo "SparkApplication CRD exists without the expected release or AskLake ownership; review shared ownership first" >&2
    exit 1
  fi
fi

helm repo add --force-update spark-operator "$CHART_REPOSITORY" >/dev/null
helm repo update spark-operator >/dev/null
helm pull "$CHART_REFERENCE" --version "$CHART_VERSION" --destination "$TEMP_DIR"
actual_chart_sha256="$(sha256_file "$CHART_ARCHIVE")"
if [[ "$actual_chart_sha256" != "$CHART_SHA256" ]]; then
  echo "Spark Operator chart checksum mismatch: expected $CHART_SHA256, got $actual_chart_sha256" >&2
  exit 1
fi

helm upgrade --install "$RELEASE_NAME" "$CHART_ARCHIVE" \
  --namespace "$OPERATOR_NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  --dry-run=server >/dev/null

helm upgrade --install "$RELEASE_NAME" "$CHART_ARCHIVE" \
  --namespace "$OPERATOR_NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE" \
  --rollback-on-failure \
  --wait \
  --timeout 10m

kubectl annotate namespace "$OPERATOR_NAMESPACE" \
  asklake.io/owner="$OWNER" \
  asklake.io/cluster="$ASKLAKE_EKS_CLUSTER_NAME" \
  asklake.io/release="$RELEASE_NAME" \
  --overwrite

for crd in "${CRDS[@]}"; do
  kubectl annotate crd "$crd" \
    asklake.io/owner="$OWNER" \
    asklake.io/cluster="$ASKLAKE_EKS_CLUSTER_NAME" \
    asklake.io/release="$RELEASE_NAME" \
    asklake.io/chart-version="$CHART_VERSION" \
    --overwrite
done

kubectl wait --for=condition=Established crd/sparkapplications.sparkoperator.k8s.io --timeout=2m
kubectl wait --for=condition=Available deployment/asklake-spark-operator-controller -n "$OPERATOR_NAMESPACE" --timeout=5m
kubectl wait --for=condition=Available deployment/asklake-spark-operator-webhook -n "$OPERATOR_NAMESPACE" --timeout=5m

bash "$ROOT_DIR/scripts/verify-eks-spark-rbac.sh"
kubectl apply --dry-run=server -f "$ADMISSION_FIXTURE" >/dev/null

for resource in sparkapplications scheduledsparkapplications sparkconnects; do
  if [[ "$(resource_count "$resource")" -ne 0 ]]; then
    echo "operator validation unexpectedly found or created a $resource object" >&2
    exit 1
  fi
done

echo "Spark Operator $CHART_VERSION is ready and restricted to $JOB_NAMESPACE. Admission dry-run passed and no Spark workload was submitted."
