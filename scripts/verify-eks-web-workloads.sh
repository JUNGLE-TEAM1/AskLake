#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/web.test.example.yaml"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-eks-web-workloads.sh"
RENDERED_FILE="$(mktemp)"
HPA_DISABLED_RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED_FILE" "$HPA_DISABLED_RENDERED"' EXIT

helm lint "$CHART_DIR"
if [[ -n "$(helm template asklake-web "$CHART_DIR")" ]]; then
  echo "disabled web chart must render zero resources" >&2
  exit 1
fi

helm lint "$CHART_DIR" -f "$VALUES_FILE"
helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" >"$RENDERED_FILE"

if [[ "$(grep -c '^kind: Deployment$' "$RENDERED_FILE")" -ne 4 ]] || \
   [[ "$(grep -c '^kind: Service$' "$RENDERED_FILE")" -ne 3 ]] || \
   [[ "$(grep -c '^kind: NetworkPolicy$' "$RENDERED_FILE")" -ne 1 ]] || \
   [[ "$(grep -c '^kind: HorizontalPodAutoscaler$' "$RENDERED_FILE")" -ne 1 ]]; then
  echo "web chart must render Frontend, FastAPI, AI Gateway, Collector Deployments, three Services, one private NetworkPolicy, and one FastAPI HPA" >&2
  exit 1
fi

for contract in \
  'name: frontend' \
  'name: fastapi' \
  'name: ai-gateway' \
  'name: trino-result-collector' \
  'apiVersion: autoscaling/v2' \
  'serviceAccountName: asklake-frontend' \
  'serviceAccountName: asklake-backend' \
  'asklake.io/workload-class: general' \
  'kubernetes.io/arch: amd64' \
  'name: asklake-runtime' \
  'name: asklake-backend-runtime' \
  'name: asklake-ai-gateway-runtime' \
  'serviceAccountName: asklake-ai-gateway' \
  'automountServiceAccountToken: false' \
  'name: INTERNAL_AUTH_TOKEN' \
  'name: PROVIDER_API_KEY' \
  'name: MCP_SERVICE_TOKEN' \
  'http://fastapi:8080/internal/mcp' \
  'name: ai-gateway-private' \
  'type: Recreate' \
  'mountPath: /var/run/asklake/secrets' \
  'key: trino-ca.pem' \
  'path: trino-ca.pem' \
  'path: /api/health' \
  'terminationGracePeriodSeconds: 360' \
  'preStop:' \
  'sleep 310' \
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

if [[ "$(grep -c '@sha256:' "$RENDERED_FILE")" -ne 4 ]]; then
  echo "web workloads must use four digest-pinned image references" >&2
  exit 1
fi

fastapi_image="$(awk '$1 == "-" && $2 == "name:" && $3 == "fastapi" { found = 1; next } found && $1 == "image:" { gsub(/\"/, "", $2); print $2; exit }' "$RENDERED_FILE")"
collector_image="$(awk '$1 == "-" && $2 == "name:" && $3 == "trino-result-collector" { found = 1; next } found && $1 == "image:" { gsub(/\"/, "", $2); print $2; exit }' "$RENDERED_FILE")"
if [[ -z "$fastapi_image" || "$collector_image" != "$fastapi_image" ]]; then
  echo "Trino collector must use the exact FastAPI backend image digest" >&2
  exit 1
fi

if [[ "$(grep -c 'kubernetes.io/arch: amd64' "$RENDERED_FILE")" -ne 4 ]]; then
  echo "web workloads must schedule all four Deployments on AMD64 nodes" >&2
  exit 1
fi

if [[ "$(grep -c 'path: /api/health' "$RENDERED_FILE")" -ne 2 ]] || \
   [[ "$(grep -c 'tcpSocket:' "$RENDERED_FILE")" -ne 2 ]]; then
  echo "backend must keep DB-aware health for startup/readiness and use TCP liveness" >&2
  exit 1
fi

if [[ "$(grep -c 'terminationGracePeriodSeconds: 360' "$RENDERED_FILE")" -ne 1 ]] || \
   [[ "$(grep -c 'sleep 310' "$RENDERED_FILE")" -ne 1 ]]; then
  echo "FastAPI must stay alive during ALB target deregistration before shutdown" >&2
  exit 1
fi

if [[ "$(grep -c '^  replicas:' "$RENDERED_FILE")" -ne 3 ]]; then
  echo "HPA-enabled render must leave FastAPI replicas to the autoscaling controller" >&2
  exit 1
fi

hpa_block="$(awk '
  /^kind: HorizontalPodAutoscaler$/ { in_hpa = 1 }
  in_hpa { print }
' "$RENDERED_FILE")"
for hpa_contract in \
  'name: fastapi' \
  'kind: Deployment' \
  'minReplicas: 2' \
  'maxReplicas: 6' \
  'averageUtilization: 60' \
  'stabilizationWindowSeconds: 300'; do
  if ! grep -Fq "$hpa_contract" <<<"$hpa_block"; then
    echo "FastAPI HPA is missing contract: $hpa_contract" >&2
    exit 1
  fi
done

helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.autoscaling.enabled=false >"$HPA_DISABLED_RENDERED"
if grep -q '^kind: HorizontalPodAutoscaler$' "$HPA_DISABLED_RENDERED" || \
   [[ "$(grep -c '^  replicas:' "$HPA_DISABLED_RENDERED")" -ne 4 ]]; then
  echo "HPA-disabled render must keep four statically sized Deployments and no HPA" >&2
  exit 1
fi

runtime_revision_rendered="$(helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" \
  --set backend.runtimeConfigRevision=runtime-revision-test)"
if [[ "$(grep -c 'asklake.io/runtime-config-revision: \"runtime-revision-test\"' <<<"$runtime_revision_rendered")" -ne 2 ]]; then
  echo "runtime ConfigMap revision must roll FastAPI and Collector together" >&2
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
  'backend.replicaCount=3'
  'backend.autoscaling.minReplicas=1'
  'backend.autoscaling.maxReplicas=7'
  'backend.autoscaling.targetCPUUtilizationPercentage=0'
  'backend.autoscaling.behavior.scaleDown.stabilizationWindowSeconds=0'
  'collector.enabled=false'
  'collector.replicaCount=0'
  'collector.replicaCount=2'
  'collector.serviceAccountName=asklake-trino'
  'frontend.service.port=8080'
  'backend.service.port=80'
  'frontend.image=nginx:latest'
  'backend.image=backend:latest'
  'aiGateway.enabled=false'
  'aiGateway.replicaCount=0'
  'aiGateway.replicaCount=2'
  'aiGateway.image=ai-gateway:latest'
  'aiGateway.service.type=LoadBalancer'
  'aiGateway.service.port=443'
  'aiGateway.serviceAccountName=asklake-backend'
  'aiGateway.mcpServerUrl=http://external.example/internal/mcp'
  'placement.nodeSelector.kubernetes\.io/arch=arm64'
)
for override in "${negative_cases[@]}"; do
  if helm template asklake-web "$CHART_DIR" -f "$VALUES_FILE" --set "$override" >/dev/null 2>&1; then
    echo "web schema accepted unsafe override: $override" >&2
    exit 1
  fi
done

if grep -Eq '^kind: (Ingress|Secret|ConfigMap)$' "$RENDERED_FILE"; then
  echo "Phase 14 web chart crossed the workload-only ownership boundary" >&2
  exit 1
fi

gateway_block="$(awk '
  /^kind: Deployment$/ { deployment = 1; block = $0 ORS; next }
  deployment { block = block $0 ORS }
  deployment && /^---$/ {
    if (block ~ /name: ai-gateway/) { printf "%s", block; exit }
    deployment = 0; block = ""
  }
' "$RENDERED_FILE")"
for contract in \
  'replicas: 1' \
  'automountServiceAccountToken: false' \
  'readOnlyRootFilesystem: true' \
  'runAsNonRoot: true' \
  'runAsUser: 10001' \
  'runAsGroup: 10001' \
  'type: RuntimeDefault' \
  'path: /health' \
  'tcpSocket:'; do
  grep -Fq "$contract" <<<"$gateway_block" || {
    echo "AI Gateway workload is missing contract: $contract" >&2
    exit 1
  }
done
[[ "$(grep -c 'runAsUser: 10001' <<<"$gateway_block")" -eq 2 ]] || {
  echo "AI Gateway must pin numeric UID 10001 at Pod and container scope" >&2
  exit 1
}
[[ "$(grep -c 'runAsGroup: 10001' <<<"$gateway_block")" -eq 2 ]] || {
  echo "AI Gateway must pin numeric GID 10001 at Pod and container scope" >&2
  exit 1
}
grep -Fq 'USER 10001:10001' "$ROOT_DIR/ai-server/Dockerfile" || {
  echo "AI Gateway image must use the same numeric UID/GID as Helm" >&2
  exit 1
}
if grep -Fq 'OPENAI_API_KEY' "$RENDERED_FILE"; then
  echo "FastAPI/web render must not expose the provider key name" >&2
  exit 1
fi

network_policy_block="$(awk '
  /^kind: NetworkPolicy$/ { policy = 1; block = $0 ORS; next }
  policy { block = block $0 ORS }
  policy && /^---$/ { printf "%s", block; exit }
' "$RENDERED_FILE")"
[[ "$(grep -c 'port: 53' <<<"$network_policy_block")" -eq 2 ]] || {
  echo "AI Gateway NetworkPolicy must allow TCP and UDP DNS" >&2
  exit 1
}
if grep -Fq 'kubernetes.io/metadata.name: kube-system' <<<"$network_policy_block"; then
  echo "AI Gateway DNS egress must support the EKS virtual DNS Service IP" >&2
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

for deploy_guard in \
  'externalsecret asklake-backend-runtime' \
  'externalsecret asklake-ai-gateway-runtime' \
  'verify-eks-ai-gateway-runtime.mjs' \
  '/api/health/ai'; do
  grep -Fq "$deploy_guard" "$DEPLOY_SCRIPT" || {
    echo "web deployment script is missing fail-closed Gateway guard: $deploy_guard" >&2
    exit 1
  }
done
for runtime_guard in \
  'ExternalSecret is not Ready' \
  'Secret is not controller-owned by its ExternalSecret' \
  'AI_GATEWAY_SERVICE_TOKEN' \
  'AI_MCP_SERVICE_TOKEN' \
  'AI_PROVIDER_API_KEY' \
  'AI_QUERY_PROVIDER' \
  'AI_GATEWAY_BASE_URL'; do
  grep -Fq "$runtime_guard" "$ROOT_DIR/scripts/verify-eks-ai-gateway-runtime.mjs" || {
    echo "Gateway runtime verifier is missing guard: $runtime_guard" >&2
    exit 1
  }
done

echo "EKS Phase 14 web workload contract verification passed."
