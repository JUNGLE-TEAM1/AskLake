#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES_FILE="$ROOT_DIR/infra/eks/values/operators/spark-operator.dev.yaml"
CHART_REPOSITORY="https://kubeflow.github.io/spark-operator"
CHART_REFERENCE="spark-operator/spark-operator"
CHART_VERSION="2.5.1"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE"' EXIT

for command in helm awk grep; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

helm repo add --force-update spark-operator "$CHART_REPOSITORY" >/dev/null
helm repo update spark-operator >/dev/null

chart_version="$(helm show chart "$CHART_REFERENCE" --version "$CHART_VERSION" | awk '$1 == "version:" {print $2}')"
app_version="$(helm show chart "$CHART_REFERENCE" --version "$CHART_VERSION" | awk '$1 == "appVersion:" {print $2}')"
if [[ "$chart_version" != "$CHART_VERSION" || "$app_version" != "$CHART_VERSION" ]]; then
  echo "Spark Operator chart/app version drifted from $CHART_VERSION" >&2
  exit 1
fi

helm template asklake-spark-operator "$CHART_REFERENCE" \
  --version "$CHART_VERSION" \
  --namespace spark-operator \
  --include-crds \
  -f "$VALUES_FILE" >"$RENDERED_FILE"

for crd in \
  sparkapplications.sparkoperator.k8s.io \
  scheduledsparkapplications.sparkoperator.k8s.io; do
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

if grep -Eq 'AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' \
  "$VALUES_FILE" "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh" "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"; then
  echo "credential-like value found in Spark Operator deployment files" >&2
  exit 1
fi

bash -n "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh"
bash -n "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"
grep -q 'install-spark-operator-2.5.1' "$ROOT_DIR/scripts/deploy-eks-spark-operator.sh"
grep -q 'delete-spark-operator-crds-after-empty-check' "$ROOT_DIR/scripts/destroy-eks-spark-operator.sh"

echo "EKS Spark Operator 2.5.1 deployment contract verification passed."
