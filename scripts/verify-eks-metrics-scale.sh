#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-scale-smoke"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/scale-smoke.test.example.yaml"
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

bash -n \
  "$ROOT_DIR/scripts/run-eks-node-scale-smoke.sh" \
  "$ROOT_DIR/scripts/verify-eks-node-scale-in.sh" \
  "$ROOT_DIR/scripts/capture-eks-day17-autoscaling-evidence.sh" \
  "$ROOT_DIR/scripts/test-eks-day17-autoscaling-evidence.sh"
node --check "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs"
bash "$ROOT_DIR/scripts/test-eks-day17-autoscaling-evidence.sh" >/dev/null

helm lint "$CHART_DIR"
[[ -z "$(helm template asklake-scale-smoke "$CHART_DIR")" ]] || { echo "disabled scale smoke must render nothing" >&2; exit 1; }
helm lint "$CHART_DIR" -f "$VALUES_FILE"
helm template asklake-scale-smoke "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED"

grep -q '^kind: Deployment$' "$RENDERED"
grep -q 'name: asklake-node-scale-smoke' "$RENDERED"
grep -q 'asklake.io/workload-class: general' "$RENDERED"
grep -q '@sha256:' "$RENDERED"
grep -q 'automountServiceAccountToken: false' "$RENDERED"

for override in \
  metricsApiReady=false \
  generalNodePoolReady=false \
  imageReceiptVerified=false \
  replicaCount=1 \
  image=backend:latest \
  nodeSelector.asklake.io/workload-class=spark; do
  if helm template asklake-scale-smoke "$CHART_DIR" -f "$VALUES_FILE" --set "$override" >/dev/null 2>&1; then
    echo "scale smoke accepted unsafe override: $override" >&2
    exit 1
  fi
done

if grep -Eq '^kind: (Service|Ingress|HorizontalPodAutoscaler|Secret)$' "$RENDERED"; then
  echo "scale smoke chart crossed its temporary Deployment-only boundary" >&2
  exit 1
fi

echo "EKS Day 14 Metrics Server and node scale smoke contract verification passed."
