#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
MODE="${1:-}"
GATEWAY_VALUES="${2:-}"
ROLLBACK_VALUES="${3:-}"
ROLLBACK_SOURCE="${4:-}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
RUNTIME_CONTRACT="${ASKLAKE_DAY16_RUNTIME_CONTRACT:-$ROOT_DIR/infra/eks/secrets/dev.day16-a.runtime-secret-contract.json}"
MANIFEST="$ROOT_DIR/infra/eks/secrets/runtime-externalsecrets.dev.yaml"
CHART="$ROOT_DIR/infra/eks/helm/asklake-runtime-config"
RELEASE="asklake-runtime-config"
RUN_ID="$(date -u +%s)-$$-${RANDOM}"
TEMPORARY_DIRECTORY="$(mktemp -d)"
FINAL_STARTED=0
STAGES_CREATED=0
GATEWAY_EXISTED=0

fail() { echo "$1" >&2; exit 1; }
cleanup() {
  if [[ "$STAGES_CREATED" -eq 1 ]]; then
    kubectl delete externalsecret "asklake-backend-runtime-stage-$RUN_ID" "asklake-ai-gateway-runtime-stage-$RUN_ID" \
      -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
    kubectl delete secret "asklake-backend-runtime-stage-$RUN_ID" "asklake-ai-gateway-runtime-stage-$RUN_ID" \
      -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT

[[ "$MODE" == "--preflight" || "$MODE" == "--apply" ]] || \
  fail "usage: $0 --preflight|--apply <private-gateway-values.yaml> <private-direct-rollback-values.yaml> <private-direct-rollback-source.json>"
for command in aws git helm jq kubectl node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
for file in "$GATEWAY_VALUES" "$ROLLBACK_VALUES" "$ROLLBACK_SOURCE" "$RUNTIME_CONTRACT" "$MANIFEST"; do [[ -s "$file" ]] || fail "Gateway promotion input is missing"; done
for file in "$GATEWAY_VALUES" "$ROLLBACK_VALUES" "$ROLLBACK_SOURCE" "$RUNTIME_CONTRACT"; do
  git -C "$ROOT_DIR" check-ignore -q -- "$file" || fail "private Gateway promotion input must remain ignored"
  [[ "$(stat -f '%Lp' "$file")" == "600" ]] || fail "private Gateway promotion input must use mode 0600"
done
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --full-service-ready "$RUNTIME_CONTRACT" >/dev/null
jq -e '.runtimeDecisions.aiRuntime.status=="selected" and .runtimeDecisions.aiRuntime.selected=="gateway"' \
  "$RUNTIME_CONTRACT" >/dev/null || fail "runtime contract has not selected Gateway"

: "${ASKLAKE_EKS_CLUSTER_NAME:?ASKLAKE_EKS_CLUSTER_NAME is required}"
verify_asklake_eks_context
helm lint "$CHART" -f "$GATEWAY_VALUES" >/dev/null
helm lint "$CHART" -f "$ROLLBACK_VALUES" >/dev/null
helm template "$RELEASE" "$CHART" -f "$GATEWAY_VALUES" | grep -q 'AI_QUERY_PROVIDER: gateway' || fail "Gateway values do not select gateway"
helm template "$RELEASE" "$CHART" -f "$GATEWAY_VALUES" | grep -q 'AI_GATEWAY_BASE_URL: http://ai-gateway:8090' || fail "Gateway base URL is invalid"
helm template "$RELEASE" "$CHART" -f "$ROLLBACK_VALUES" | grep -q 'AI_QUERY_PROVIDER: direct' || fail "rollback values do not select direct"
if helm template "$RELEASE" "$CHART" -f "$ROLLBACK_VALUES" | grep -q 'AI_GATEWAY_BASE_URL: http'; then
  fail "direct rollback values must remove AI_GATEWAY_BASE_URL"
fi

backend_source="$TEMPORARY_DIRECTORY/backend-source.json"
gateway_source="$TEMPORARY_DIRECTORY/gateway-source.json"
aws secretsmanager get-secret-value --region "$REGION" --secret-id asklake/dev/backend/runtime --query SecretString --output text >"$backend_source"
aws secretsmanager get-secret-value --region "$REGION" --secret-id asklake/dev/ai-gateway/runtime --query SecretString --output text >"$gateway_source"
backend_keys='["AI_CONTEXT_SIGNING_SECRET","AI_GATEWAY_SERVICE_TOKEN","AI_MCP_SERVICE_TOKEN","AIRFLOW_EXECUTION_API_TOKEN","AIRFLOW_INTERNAL_TOKEN","AIRFLOW_PASSWORD","BOOTSTRAP_ADMIN_PASSWORD","DATABASE_URL","TRINO_AUTH_PASSWORD","TRINO_AUTH_USERNAME","TRINO_MATERIALIZER_PASSWORD","TRINO_MATERIALIZER_USERNAME","TRINO_QUERY_CONFIRMATION_SECRET","TRINO_RESULT_CURSOR_SECRET","trino-ca.pem"]'
gateway_keys='["AI_GATEWAY_SERVICE_TOKEN","AI_MCP_SERVICE_TOKEN","AI_PROVIDER_API_KEY"]'
direct_keys='["AIRFLOW_EXECUTION_API_TOKEN","AIRFLOW_INTERNAL_TOKEN","AIRFLOW_PASSWORD","BOOTSTRAP_ADMIN_PASSWORD","DATABASE_URL","OPENAI_API_KEY","TRINO_AUTH_PASSWORD","TRINO_AUTH_USERNAME","TRINO_MATERIALIZER_PASSWORD","TRINO_MATERIALIZER_USERNAME","TRINO_QUERY_CONFIRMATION_SECRET","TRINO_RESULT_CURSOR_SECRET","trino-ca.pem"]'
jq -e --argjson keys "$backend_keys" '(keys|sort)==($keys|sort) and all(.[]; type=="string" and length>0)' "$backend_source" >/dev/null || fail "Backend source is not the exact 15-key Gateway profile"
jq -e --argjson keys "$gateway_keys" '(keys|sort)==($keys|sort) and all(.[]; type=="string" and length>0)' "$gateway_source" >/dev/null || fail "AI Gateway source is not the exact three-key profile"
jq -e --argjson keys "$direct_keys" '
  (keys|sort)==($keys|sort) and all(.[]; type=="string" and length>0)
  and (.OPENAI_API_KEY|startswith("sk-") and length>=20)
' "$ROLLBACK_SOURCE" >/dev/null || fail "direct rollback source is not the exact validated 13-key profile"
jq -e --slurpfile gateway "$gateway_source" '
  .AI_GATEWAY_SERVICE_TOKEN==$gateway[0].AI_GATEWAY_SERVICE_TOKEN
  and .AI_MCP_SERVICE_TOKEN==$gateway[0].AI_MCP_SERVICE_TOKEN
  and (has("AI_PROVIDER_API_KEY")|not)
' "$backend_source" >/dev/null || fail "shared token bindings differ or Backend contains provider credentials"

kubectl apply --dry-run=server -f "$MANIFEST" >/dev/null
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$GATEWAY_VALUES" --dry-run=server >/dev/null
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$ROLLBACK_VALUES" --dry-run=server >/dev/null
[[ "$MODE" == "--preflight" ]] && { echo "ai_gateway_runtime_promotion=preflight-ready live_mutation=false"; exit 0; }
[[ "${ASKLAKE_AI_GATEWAY_PROMOTION_CONFIRM:-}" == "promote-staged-ai-gateway-runtime" ]] || \
  fail "set ASKLAKE_AI_GATEWAY_PROMOTION_CONFIRM=promote-staged-ai-gateway-runtime"

kubectl get externalsecret asklake-backend-runtime -n "$NAMESPACE" -o json >"$TEMPORARY_DIRECTORY/backend-before.json"
if kubectl get externalsecret asklake-ai-gateway-runtime -n "$NAMESPACE" -o json >"$TEMPORARY_DIRECTORY/gateway-before.json" 2>/dev/null; then
  GATEWAY_EXISTED=1
fi
helm get values "$RELEASE" -n "$NAMESPACE" -o yaml >"$TEMPORARY_DIRECTORY/runtime-before.yaml"

rollback() {
  aws secretsmanager put-secret-value --region "$REGION" --secret-id asklake/dev/backend/runtime \
    --secret-string "file://$ROLLBACK_SOURCE" >/dev/null
  jq '{apiVersion,kind,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels,annotations:.metadata.annotations},spec}' "$TEMPORARY_DIRECTORY/backend-before.json" | kubectl apply -f - >/dev/null
  if [[ "$GATEWAY_EXISTED" -eq 1 ]]; then
    jq '{apiVersion,kind,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels,annotations:.metadata.annotations},spec}' "$TEMPORARY_DIRECTORY/gateway-before.json" | kubectl apply -f - >/dev/null
  else
    kubectl delete externalsecret asklake-ai-gateway-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null
    kubectl delete secret asklake-ai-gateway-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null
  fi
  kubectl annotate externalsecret asklake-backend-runtime -n "$NAMESPACE" "force-sync=$(date +%s)" --overwrite >/dev/null
  kubectl wait --for=condition=Ready externalsecret/asklake-backend-runtime -n "$NAMESPACE" --timeout=3m >/dev/null
  helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$ROLLBACK_VALUES" --atomic --wait --timeout 5m >/dev/null
  kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null
  kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null
}
on_error() {
  status=$?
  if [[ "$status" -ne 0 && "$FINAL_STARTED" -eq 1 ]]; then
    echo "Gateway promotion failed; restoring the 13-key source, ExternalSecrets and explicit direct rollback runtime" >&2
    rollback || status=1
  fi
  exit "$status"
}
trap on_error ERR

kubectl create --dry-run=client -f "$MANIFEST" -o json | jq -s \
  '[.[] | select(.metadata.name=="asklake-backend-runtime" or .metadata.name=="asklake-ai-gateway-runtime")]' \
  >"$TEMPORARY_DIRECTORY/desired.json"
[[ "$(jq length "$TEMPORARY_DIRECTORY/desired.json")" == "2" ]] || fail "tracked manifest did not produce the two Gateway targets"
for name in asklake-backend-runtime asklake-ai-gateway-runtime; do
  stage="$name-stage-$RUN_ID"
  STAGES_CREATED=1
  jq --arg name "$name" --arg stage "$stage" '.[]|select(.metadata.name==$name)|.metadata.name=$stage|.spec.target.name=$stage' \
    "$TEMPORARY_DIRECTORY/desired.json" | kubectl apply -f - >/dev/null
  kubectl wait --for=condition=Ready "externalsecret/$stage" -n "$NAMESPACE" --timeout=3m >/dev/null
  source_file="$backend_source"; [[ "$name" == "asklake-ai-gateway-runtime" ]] && source_file="$gateway_source"
  source_hash="$(jq -S -c . "$source_file" | shasum -a 256 | awk '{print $1}')"
  target_hash="$(kubectl get secret "$stage" -n "$NAMESPACE" -o json | jq -S -c '.data|with_entries(.value|=@base64d)' | shasum -a 256 | awk '{print $1}')"
  [[ "$source_hash" == "$target_hash" ]] || fail "staged $name target differs from its source"
done

FINAL_STARTED=1
kubectl apply -f "$MANIFEST" >/dev/null
kubectl wait --for=condition=Ready externalsecret/asklake-backend-runtime externalsecret/asklake-ai-gateway-runtime -n "$NAMESPACE" --timeout=3m >/dev/null
helm upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$GATEWAY_VALUES" --atomic --wait --timeout 5m >/dev/null
kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null
FINAL_STARTED=0
echo "ai_gateway_runtime_promotion=ready backend_keys=15 gateway_keys=3 rollback=armed"
