#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/web.test.example.yaml"
RENDERED_FILE="$(mktemp)"
trap 'rm -f "$RENDERED_FILE"' EXIT

helm lint "$CHART_DIR"
if [[ -n "$(helm template asklake-web "$CHART_DIR")" ]]; then
  echo "disabled web chart must render zero resources" >&2
  exit 1
fi

helm lint "$CHART_DIR" -f "$VALUES_FILE"
helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

if [[ "$(grep -c '^kind: Deployment$' "$RENDERED_FILE")" -ne 3 ]] || \
   [[ "$(grep -c '^kind: Service$' "$RENDERED_FILE")" -ne 2 ]]; then
  echo "web chart must render Frontend, FastAPI, Collector Deployments and two Services" >&2
  exit 1
fi

for contract in \
  'name: frontend' \
  'name: fastapi' \
  'name: trino-result-collector' \
  'serviceAccountName: asklake-frontend' \
  'serviceAccountName: asklake-backend' \
  'asklake.io/workload-class: general' \
  'kubernetes.io/arch: amd64' \
  'name: asklake-runtime' \
  'name: asklake-backend-runtime' \
  'mountPath: /var/run/asklake/secrets' \
  'key: trino-ca.pem' \
  'path: trino-ca.pem' \
  'path: /api/health' \
  'terminationGracePeriodSeconds: 360' \
  'preStop:' \
  'sleep 310' \
  'asklake.io/runtime-config-revision: "0000000000000000000000000000000000000000"' \
  'scripts/collect-trino-results.py' \
  'containerPort: 80' \
  'containerPort: 8080'; do
  if ! grep -Fq "$contract" "$RENDERED_FILE"; then
    echo "rendered web workload is missing contract: $contract" >&2
    exit 1
  fi
done

helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.trinoRuntimeSecretName=asklake-backend-trino-runtime >"$RENDERED_FILE"
grep -Fq 'name: asklake-backend-trino-runtime' "$RENDERED_FILE"
grep -Fq 'secretName: asklake-backend-trino-runtime' "$RENDERED_FILE"

if [[ "$(grep -c '@sha256:' "$RENDERED_FILE")" -ne 3 ]]; then
  echo "web workloads must use three digest-pinned image references" >&2
  exit 1
fi

fastapi_image="$(awk '$1 == "-" && $2 == "name:" && $3 == "fastapi" { found = 1; next } found && $1 == "image:" { gsub(/\"/, "", $2); print $2; exit }' "$RENDERED_FILE")"
collector_image="$(awk '$1 == "-" && $2 == "name:" && $3 == "trino-result-collector" { found = 1; next } found && $1 == "image:" { gsub(/\"/, "", $2); print $2; exit }' "$RENDERED_FILE")"
if [[ -z "$fastapi_image" || "$collector_image" != "$fastapi_image" ]]; then
  echo "Trino collector must use the exact FastAPI backend image digest" >&2
  exit 1
fi

if [[ "$(grep -c 'kubernetes.io/arch: amd64' "$RENDERED_FILE")" -ne 3 ]]; then
  echo "web workloads must schedule all three Deployments on AMD64 nodes" >&2
  exit 1
fi

if [[ "$(grep -c 'path: /api/health' "$RENDERED_FILE")" -ne 2 ]] || \
   [[ "$(grep -c 'tcpSocket:' "$RENDERED_FILE")" -ne 1 ]]; then
  echo "backend must keep DB-aware health for startup/readiness and use TCP liveness" >&2
  exit 1
fi

if [[ "$(grep -c 'terminationGracePeriodSeconds: 360' "$RENDERED_FILE")" -ne 1 ]] || \
   [[ "$(grep -c 'sleep 310' "$RENDERED_FILE")" -ne 1 ]]; then
  echo "FastAPI must stay alive during ALB target deregistration before shutdown" >&2
  exit 1
fi

negative_cases=(
  'readiness.backendRuntimeBoundaryReady=false'
  'readiness.runtimeSecretReady=false'
  'readiness.generalNodePoolReady=false'
  'frontend.replicaCount=1'
  'backend.replicaCount=1'
  'backend.terminationGracePeriodSeconds=120'
  'backend.preStopDelaySeconds=0'
  'backend.runtimeConfigRevision=invalid'
  'collector.enabled=false'
  'collector.replicaCount=0'
  'collector.replicaCount=2'
  'collector.serviceAccountName=asklake-trino'
  'frontend.service.port=8080'
  'backend.service.port=80'
  'frontend.image=nginx:latest'
  'backend.image=backend:latest'
  'placement.nodeSelector.kubernetes\.io/arch=arm64'
)
for override in "${negative_cases[@]}"; do
  if helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" --set "$override" >/dev/null 2>&1; then
    echo "web schema accepted unsafe override: $override" >&2
    exit 1
  fi
done

if grep -Eq '^kind: (Ingress|HorizontalPodAutoscaler|Secret|ConfigMap)$' "$RENDERED_FILE"; then
  echo "Phase 14 web chart crossed the workload-only ownership boundary" >&2
  exit 1
fi

collector_block="$(awk '
  /^  name: trino-result-collector$/ { in_collector = 1 }
  in_collector { print }
' "$RENDERED_FILE")"
grep -Fq 'automountServiceAccountToken: false' <<<"$collector_block"
if grep -Eq '^kind: Service$|containerPort:|uvicorn|/api/health' <<<"$collector_block"; then
  echo "Trino collector must be a private worker without HTTP or Service resources" >&2
  exit 1
fi

if grep -REiq '(AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' \
  "$CHART_DIR" "$VALUES_FILE"; then
  echo "credential-like value found in Phase 14 web files" >&2
  exit 1
fi

grep -q -- '--dry-run=server' "$ROOT_DIR/scripts/deploy-eks-web-workloads.sh"
grep -q 'helm upgrade --install asklake-web' "$ROOT_DIR/scripts/deploy-eks-web-workloads.sh"
if grep -q 'kubectl apply --server-side --dry-run=server -f "$RENDERED_FILE"' \
  "$ROOT_DIR/scripts/deploy-eks-web-workloads.sh"; then
  echo "web workload upgrade preflight must preserve Helm field ownership" >&2
  exit 1
fi

echo "EKS Phase 14 web workload contract verification passed."
