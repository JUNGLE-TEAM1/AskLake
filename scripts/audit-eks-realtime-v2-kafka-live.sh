#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---preflight}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
SERVICE_ACCOUNT="asklake-realtime-v2-connect"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "$1" >&2
  exit 1
}

[[ "$MODE" == "--preflight" || "$MODE" == "--e2e" ]] \
  || fail "usage: $0 --preflight|--e2e"
for command in aws jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
verify_asklake_eks_context
[[ "$ASKLAKE_VERIFIED_EKS_NAMESPACE" == "$NAMESPACE" ]] \
  || fail "verified namespace does not match the Kafka audit target"

associations="$(aws eks list-pod-identity-associations \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --region "$REGION" --output json)"
association_id="$(jq -r --arg namespace "$NAMESPACE" --arg serviceAccount "$SERVICE_ACCOUNT" '
  [.associations[]? | select(.namespace == $namespace and .serviceAccount == $serviceAccount)]
  | if length == 1 then .[0].associationId else "" end
' <<<"$associations")"
[[ -n "$association_id" ]] || fail "Kafka Connect V2 requires exactly one Pod Identity association"
association="$(aws eks describe-pod-identity-association \
  --cluster-name "$ASKLAKE_EKS_CLUSTER_NAME" --association-id "$association_id" \
  --region "$REGION" --output json)"
role_arn="$(jq -r '.association.roleArn // ""' <<<"$association")"
[[ "$role_arn" =~ ^arn:[^:]+:iam::[0-9]{12}:role/.+ ]] \
  || fail "Kafka Connect V2 Pod Identity association has no valid role"
role_name="${role_arn##*/}"
: >"$TEMP_DIR/policies.jsonl"
while IFS= read -r policy_arn; do
  [[ -n "$policy_arn" ]] || continue
  default_version="$(aws iam get-policy --policy-arn "$policy_arn" \
    --query 'Policy.DefaultVersionId' --output text)"
  aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$default_version" \
    --query 'PolicyVersion.Document' --output json >>"$TEMP_DIR/policies.jsonl"
done < <(aws iam list-attached-role-policies --role-name "$role_name" --output json \
  | jq -r '.AttachedPolicies[].PolicyArn')
jq -s '.' "$TEMP_DIR/policies.jsonl" >"$TEMP_DIR/policies.json"

kubectl get --raw \
  "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors" \
  >"$TEMP_DIR/names.json"
jq -e 'type == "array" and all(.[]; test("^[A-Za-z0-9._-]+$"))' \
  "$TEMP_DIR/names.json" >/dev/null || fail "Kafka Connect returned invalid connector names"
: >"$TEMP_DIR/connectors.jsonl"
while IFS= read -r connector_name; do
  [[ -n "$connector_name" ]] || continue
  kubectl get --raw \
    "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors/$connector_name/config" \
    >"$TEMP_DIR/config.json"
  kubectl get --raw \
    "/api/v1/namespaces/$NAMESPACE/services/http:kafka-connect-v2:8083/proxy/connectors/$connector_name/status" \
    >"$TEMP_DIR/status.json"
  jq -n --arg name "$connector_name" \
    --slurpfile config "$TEMP_DIR/config.json" \
    --slurpfile status "$TEMP_DIR/status.json" \
    '{name:$name, config:$config[0], status:$status[0]}' \
    >>"$TEMP_DIR/connectors.jsonl"
done < <(jq -r '.[]' "$TEMP_DIR/names.json")
jq -s '.' "$TEMP_DIR/connectors.jsonl" >"$TEMP_DIR/connectors.json"

require_running=false
[[ "$MODE" == "--e2e" ]] && require_running=true
jq -n --argjson requireRunning "$require_running" \
  --slurpfile policies "$TEMP_DIR/policies.json" \
  --slurpfile connectors "$TEMP_DIR/connectors.json" \
  '{
    requireRunning:$requireRunning,
    policyDocuments:$policies[0],
    internalTopics:[],
    sourceTopics:($connectors[0] | map(.config.topics) | unique),
    connectors:$connectors[0]
  }' >"$TEMP_DIR/contract.json"
chmod 600 "$TEMP_DIR"/*.json "$TEMP_DIR"/*.jsonl

node "$ROOT_DIR/scripts/verify-eks-realtime-v2-kafka-contract.mjs" "$TEMP_DIR/contract.json"
