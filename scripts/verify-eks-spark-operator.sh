#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES_FILE="$ROOT_DIR/infra/eks/values/operators/spark-operator.dev.yaml"
ADMISSION_FIXTURE="$ROOT_DIR/infra/eks/smoke/sparkapplication-admission.yaml"
CHART_REPOSITORY="https://kubeflow.github.io/spark-operator"
CHART_REFERENCE="spark-operator/spark-operator"
CHART_VERSION="2.5.1"
CHART_SHA256="835ca955f65e221c79f7ef3ac7ef9070c71d30ea7ed06f242c41fc56fe9e8f1f"
TEMP_DIR="$(mktemp -d)"
CHART_ARCHIVE="$TEMP_DIR/spark-operator-$CHART_VERSION.tgz"
RENDERED_FILE="$TEMP_DIR/rendered.yaml"
trap 'rm -rf "$TEMP_DIR"' EXIT

for command in helm awk grep; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required" >&2
    return 1
  fi
}

helm repo add --force-update spark-operator "$CHART_REPOSITORY" >/dev/null
helm repo update spark-operator >/dev/null
helm pull "$CHART_REFERENCE" --version "$CHART_VERSION" --destination "$TEMP_DIR"

actual_chart_sha256="$(sha256_file "$CHART_ARCHIVE")"
if [[ "$actual_chart_sha256" != "$CHART_SHA256" ]]; then
  echo "Spark Operator chart checksum mismatch: expected $CHART_SHA256, got $actual_chart_sha256" >&2
  exit 1
fi

chart_version="$(helm show chart "$CHART_ARCHIVE" | awk '$1 == "version:" {print $2}')"
app_version="$(helm show chart "$CHART_ARCHIVE" | awk '$1 == "appVersion:" {print $2}')"
if [[ "$chart_version" != "$CHART_VERSION" || "$app_version" != "$CHART_VERSION" ]]; then
  echo "Spark Operator chart/app version drifted from $CHART_VERSION" >&2
  exit 1
fi

helm template asklake-spark-operator "$CHART_ARCHIVE" \
  --namespace spark-operator \
  --include-crds \
  -f "$VALUES_FILE" >"$RENDERED_FILE"

for crd in \
  sparkapplications.sparkoperator.k8s.io \
  scheduledsparkapplications.sparkoperator.k8s.io \
  sparkconnects.sparkoperator.k8s.io; do
  if ! grep -q "name: $crd" "$RENDERED_FILE"; then
    echo "render is missing required CRD: $crd" >&2
    exit 1
  fi
done

controller_count="$(grep -c 'app.kubernetes.io/component: controller' "$RENDERED_FILE")"
webhook_count="$(grep -c 'app.kubernetes.io/component: webhook' "$RENDERED_FILE")"
if [[ "$controller_count" -eq 0 || "$webhook_count" -eq 0 ]]; then
  echo "render is missing the controller or admission webhook" >&2
  exit 1
fi

grep -q -- '--namespaces=asklake-dev' "$RENDERED_FILE"
grep -q 'kubernetes.io/metadata.name' "$RENDERED_FILE"
grep -q -- '- asklake-dev' "$RENDERED_FILE"
grep -q 'failurePolicy: Fail' "$RENDERED_FILE"
grep -q 'asklake.io/workload-class: general' "$RENDERED_FILE"
grep -q 'memory: 300Mi' "$RENDERED_FILE"
grep -q 'memory: 1Gi' "$RENDERED_FILE"
grep -q 'controller:2.5.1@sha256:0392ad9d44afe83e9507ed0e24415f3b58de4b1cf51baabf5f6309ae280cfdce' "$RENDERED_FILE"
grep -q 'kubectl:2.5.1@sha256:8def62e2e4fb3fc5a71a388e1b95f95c2a16bde81f4d1a83528405a12a17f364' "$RENDERED_FILE"

if grep -q -- '--namespaces=$' "$RENDERED_FILE" || grep -q 'namespace: default' "$RENDERED_FILE"; then
  echo "Spark Operator render is not restricted to asklake-dev" >&2
  exit 1
fi

if grep -A8 '^kind: ServiceAccount$' "$RENDERED_FILE" | grep -q 'name: asklake-spark$'; then
  echo "upstream chart attempted to recreate the Foundation-owned asklake-spark ServiceAccount" >&2
  exit 1
fi

for expected in \
  'apiVersion: sparkoperator.k8s.io/v1beta2' \
  'sparkVersion: 4.0.1' \
  'serviceAccount: asklake-spark' \
  'example.invalid/asklake/spark-runtime@sha256:'; do
  grep -q "$expected" "$ADMISSION_FIXTURE"
done

if grep -Eq 'AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' \
  "$VALUES_FILE" "$ADMISSION_FIXTURE" \
  "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh" \
  "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"; then
  echo "credential-like value found in Spark Operator deployment files" >&2
  exit 1
fi

bash -n "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh"
bash -n "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"
bash -n "$ROOT_DIR/scripts/verify-eks-spark-rbac.sh"
grep -q 'install-spark-operator-2.5.1' "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh"
grep -q 'uninstall-spark-operator-after-empty-check' "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"
grep -q 'delete-owned-empty-spark-operator-crds' "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"

echo "EKS Spark Operator 2.5.1 deployment contract and chart checksum verification passed."
