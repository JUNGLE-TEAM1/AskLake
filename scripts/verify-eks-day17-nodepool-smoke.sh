#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT_DIR/infra/eks/helm/asklake-day17-nodepool-smoke"
VALUES="$ROOT_DIR/infra/eks/values/workloads/day17-nodepool-smoke.test.example.json"
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

helm lint "$CHART"
[[ -z "$(helm template asklake-day17-nodepool-smoke "$CHART")" ]] || { echo "disabled Day 17 smoke must render nothing" >&2; exit 1; }
helm lint "$CHART" -f "$VALUES"
helm template asklake-day17-nodepool-smoke "$CHART" -f "$VALUES" >"$RENDERED"

[[ "$(grep -c '^kind: Deployment$' "$RENDERED")" == "2" ]]
[[ "$(grep -c '^kind: Pod$' "$RENDERED")" == "1" ]]
grep -q 'name: asklake-day17-general-scale' "$RENDERED"
grep -q 'name: asklake-day17-spark-scale' "$RENDERED"
grep -q 'name: asklake-day17-spark-negative' "$RENDERED"
grep -q 'asklake.io/day17-run: "0000000000000000"' "$RENDERED"
grep -q 'asklake.io/workload-class: general' "$RENDERED"
grep -q 'asklake.io/workload-class: spark' "$RENDERED"
[[ "$(grep -c 'effect: NoSchedule' "$RENDERED")" == "1" ]]
[[ "$(grep -c 'automountServiceAccountToken: false' "$RENDERED")" == "3" ]]

for override in \
  enabled=false \
  runFingerprint=bad \
  image=backend:latest \
  general.replicas=2 \
  spark.replicas=0 \
  negativeSparkProbe=false \
  general.resources.requests.cpu=3 \
  spark.resources.requests.cpu=8; do
  if helm template asklake-day17-nodepool-smoke "$CHART" -f "$VALUES" --set "$override" >/dev/null 2>&1; then
    echo "Day 17 smoke accepted unsafe override: $override" >&2
    exit 1
  fi
done

echo "EKS Day 17 isolated NodePool smoke contract verification passed."
