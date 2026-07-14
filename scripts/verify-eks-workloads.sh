#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE"' EXIT

required_files=(
  "$CHART_DIR/Chart.yaml"
  "$CHART_DIR/values.yaml"
  "$CHART_DIR/values.schema.json"
  "$CHART_DIR/templates/backend-configmap.yaml"
  "$CHART_DIR/templates/backend-deployment.yaml"
  "$CHART_DIR/templates/backend-service.yaml"
  "$CHART_DIR/templates/frontend-deployment.yaml"
  "$CHART_DIR/templates/frontend-service.yaml"
  "$VALUES_FILE"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing required EKS workload file: $required_file" >&2
    exit 1
  fi
done

HELM_BIN="${ASKLAKE_HELM_BIN:-}"
if [[ -z "$HELM_BIN" ]] && command -v helm >/dev/null 2>&1; then
  HELM_BIN="$(command -v helm)"
fi
if [[ -z "$HELM_BIN" || ! -x "$HELM_BIN" ]]; then
  echo "helm is required to verify the EKS workload chart" >&2
  exit 1
fi

"$HELM_BIN" lint "$CHART_DIR" -f "$VALUES_FILE"
"$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.sparkRunner=rest >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-Kubernetes Spark runner" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-workloads "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.config.trinoBaseUrl=http://trino:8080 >/dev/null 2>&1; then
  echo "EKS workload schema accepted a non-HTTPS Trino endpoint" >&2
  exit 1
fi

test "$(grep -c '^kind: Deployment$' "$RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: Service$' "$RENDERED_FILE")" -eq 2
test "$(grep -c '^kind: ConfigMap$' "$RENDERED_FILE")" -eq 1

grep -q 'name: asklake-frontend' "$RENDERED_FILE"
grep -q 'name: asklake-backend' "$RENDERED_FILE"
grep -q 'name: frontend' "$RENDERED_FILE"
grep -q 'name: fastapi' "$RENDERED_FILE"
grep -q 'serviceAccountName: asklake-frontend' "$RENDERED_FILE"
grep -q 'serviceAccountName: asklake-backend' "$RENDERED_FILE"
grep -q 'type: ClusterIP' "$RENDERED_FILE"
grep -q 'path: /api/health' "$RENDERED_FILE"
grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "external_ec2"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS: "60"' "$RENDERED_FILE"
grep -q 'ASKLAKE_SPARK_RUNNER: "kubernetes"' "$RENDERED_FILE"
grep -q 'TRINO_BASE_URL: "https://asklake-trino.asklake-dev.svc.cluster.local:8443"' "$RENDERED_FILE"
grep -q 'secretKeyRef:' "$RENDERED_FILE"
grep -Eq 'image: ".+@sha256:[0-9a-f]{64}"' "$RENDERED_FILE"

if grep -Eq '^kind: (Secret|Job|StatefulSet)$|type: LoadBalancer|asklake-replay-producer|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY' "$RENDERED_FILE"; then
  echo "rendered EKS workload contains an excluded resource or credential field" >&2
  exit 1
fi

bash -n "$ROOT_DIR/scripts/verify-eks-workloads.sh"
echo "EKS workload contract verification passed."
