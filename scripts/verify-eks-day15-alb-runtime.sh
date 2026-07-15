#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
FRONTEND_BODY="$(mktemp)"
BACKEND_BODY="$(mktemp)"
trap 'rm -f "$FRONTEND_BODY" "$BACKEND_BODY"' EXIT

for command in aws curl jq kubectl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

ingresses_json="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
ingress_count="$(jq '.items | length' <<<"$ingresses_json")"
backend_host="$(jq -r '.items[] | select(.metadata.name == "asklake-backend") | .status.loadBalancer.ingress[0].hostname // ""' <<<"$ingresses_json")"
frontend_host="$(jq -r '.items[] | select(.metadata.name == "asklake-frontend") | .status.loadBalancer.ingress[0].hostname // ""' <<<"$ingresses_json")"

if [[ "$ingress_count" -ne 2 || -z "$backend_host" || "$backend_host" != "$frontend_host" ]]; then
  echo "frontend/backend Ingress must share one ready ALB address" >&2
  exit 1
fi

load_balancers_json="$(aws elbv2 describe-load-balancers --region "$AWS_REGION" --output json)"
load_balancer_json="$(jq -c --arg hostname "$backend_host" '.LoadBalancers[] | select(.DNSName == $hostname)' <<<"$load_balancers_json")"
if [[ -z "$load_balancer_json" ]]; then
  echo "the Ingress ALB was not found in the selected AWS region" >&2
  exit 1
fi

load_balancer_arn="$(jq -r '.LoadBalancerArn' <<<"$load_balancer_json")"
load_balancer_state="$(jq -r '.State.Code' <<<"$load_balancer_json")"
availability_zone_count="$(jq '.AvailabilityZones | length' <<<"$load_balancer_json")"

if [[ "$load_balancer_state" != "active" ]]; then
  echo "ALB is not active: $load_balancer_state" >&2
  exit 1
fi
if ! jq -e '
  .Scheme == "internet-facing"
  and .Type == "application"
  and .IpAddressType == "ipv4"
  and (.AvailabilityZones | length) >= 2
' <<<"$load_balancer_json" >/dev/null; then
  echo "ALB exposure, type, address family or availability-zone contract drifted" >&2
  exit 1
fi

target_groups_json="$(aws elbv2 describe-target-groups \
  --region "$AWS_REGION" \
  --load-balancer-arn "$load_balancer_arn" \
  --output json)"
target_group_count="$(jq '.TargetGroups | length' <<<"$target_groups_json")"
if [[ "$target_group_count" -ne 2 ]]; then
  echo "expected two ALB target groups, found: $target_group_count" >&2
  exit 1
fi

healthy_targets=0
draining_targets=0
forbidden_targets=0
while IFS= read -r target_group_arn; do
  [[ -n "$target_group_arn" ]] || continue
  target_health_json="$(aws elbv2 describe-target-health \
    --region "$AWS_REGION" \
    --target-group-arn "$target_group_arn" \
    --output json)"
  group_healthy="$(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State == "healthy")] | length' <<<"$target_health_json")"
  if [[ "$group_healthy" -lt 2 ]]; then
    echo "each target group must have at least two healthy Pod targets" >&2
    exit 1
  fi
  healthy_targets=$((healthy_targets + group_healthy))
  draining_targets=$((draining_targets + $(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State == "draining")] | length' <<<"$target_health_json")))
  forbidden_targets=$((forbidden_targets + $(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State != "healthy" and .TargetHealth.State != "draining")] | length' <<<"$target_health_json")))
done <<<"$(jq -r '.TargetGroups[].TargetGroupArn' <<<"$target_groups_json")"

if [[ "$forbidden_targets" -ne 0 ]]; then
  echo "ALB has targets outside the allowed healthy/draining rollout states" >&2
  exit 1
fi

frontend_status="$(curl -sS -o "$FRONTEND_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 20 "http://$frontend_host/")"
backend_status="$(curl -sS -o "$BACKEND_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 20 "http://$backend_host/api/health")"
database_ok="$(jq -r '.database.ok == true' "$BACKEND_BODY")"

if [[ "$frontend_status" != "200" || "$backend_status" != "200" || "$database_ok" != "true" ]]; then
  echo "ALB frontend or backend/RDS health smoke failed" >&2
  exit 1
fi

jq -n \
  --argjson ingressCount "$ingress_count" \
  --arg albState "$load_balancer_state" \
  --argjson availabilityZoneCount "$availability_zone_count" \
  --argjson targetGroupCount "$target_group_count" \
  --argjson healthyTargets "$healthy_targets" \
  --argjson drainingTargets "$draining_targets" \
  --argjson frontendHttpStatus "$frontend_status" \
  --argjson backendHttpStatus "$backend_status" \
  --argjson databaseOk "$database_ok" \
  '{
    ingressCount: $ingressCount,
    sharedAlb: true,
    albState: $albState,
    availabilityZoneCount: $availabilityZoneCount,
    targetGroupCount: $targetGroupCount,
    healthyTargets: $healthyTargets,
    drainingTargets: $drainingTargets,
    frontendHttpStatus: $frontendHttpStatus,
    backendHttpStatus: $backendHttpStatus,
    backendDatabaseOk: $databaseOk
  }'
