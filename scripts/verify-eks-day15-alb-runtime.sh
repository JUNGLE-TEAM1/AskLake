#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

MODE="${1:---steady}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
FRONTEND_BODY="$(mktemp)"
BACKEND_BODY="$(mktemp)"
trap 'rm -f "$FRONTEND_BODY" "$BACKEND_BODY"' EXIT

if [[ "$MODE" != "--steady" && "$MODE" != "--rollout" ]]; then
  echo "usage: $0 --steady|--rollout" >&2
  exit 2
fi

for command in aws curl jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command is missing: $command" >&2
    exit 1
  }
done
verify_asklake_eks_context

ready_endpoint_ips() {
  local service="$1"
  kubectl get endpointslice -n "$NAMESPACE" \
    -l "kubernetes.io/service-name=$service" -o json \
    | jq -r '.items[].endpoints[]? | select(.conditions.ready == true) | .addresses[]?' \
    | LC_ALL=C sort -u
}

ingresses_json="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
ingress_count="$(jq '.items | length' <<<"$ingresses_json")"
backend_host="$(jq -r '.items[] | select(.metadata.name == "asklake-backend") | .status.loadBalancer.ingress[0].hostname // ""' <<<"$ingresses_json")"
frontend_host="$(jq -r '.items[] | select(.metadata.name == "asklake-frontend") | .status.loadBalancer.ingress[0].hostname // ""' <<<"$ingresses_json")"
[[ "$ingress_count" -eq 2 && -n "$backend_host" && "$backend_host" == "$frontend_host" ]] || {
  echo "frontend/backend Ingress must share one ready ALB address" >&2
  exit 1
}

load_balancers_json="$(aws elbv2 describe-load-balancers --region "$REGION" --output json)"
load_balancer_json="$(jq -c --arg hostname "$backend_host" '[.LoadBalancers[] | select(.DNSName == $hostname)][0] // empty' <<<"$load_balancers_json")"
[[ -n "$load_balancer_json" ]] || {
  echo "the Ingress ALB was not found in the selected AWS region" >&2
  exit 1
}

load_balancer_arn="$(jq -r '.LoadBalancerArn' <<<"$load_balancer_json")"
load_balancer_state="$(jq -r '.State.Code' <<<"$load_balancer_json")"
availability_zone_count="$(jq '.AvailabilityZones | length' <<<"$load_balancer_json")"
jq -e '
  .State.Code == "active"
  and .Scheme == "internet-facing"
  and .Type == "application"
  and .IpAddressType == "ipv4"
  and (.AvailabilityZones | length) >= 2
' <<<"$load_balancer_json" >/dev/null || {
  echo "ALB state, exposure, type, address family or availability-zone contract drifted" >&2
  exit 1
}

listeners_json="$(aws elbv2 describe-listeners \
  --region "$REGION" --load-balancer-arn "$load_balancer_arn" --output json)"
jq -e '.Listeners | length == 1 and .[0].Protocol == "HTTP" and .[0].Port == 80' \
  <<<"$listeners_json" >/dev/null || {
  echo "ALB must expose exactly one HTTP listener on port 80" >&2
  exit 1
}
listener_arn="$(jq -r '.Listeners[0].ListenerArn' <<<"$listeners_json")"
rules_json="$(aws elbv2 describe-rules --region "$REGION" --listener-arn "$listener_arn" --output json)"

target_groups_json="$(aws elbv2 describe-target-groups \
  --region "$REGION" --load-balancer-arn "$load_balancer_arn" --output json)"
[[ "$(jq '.TargetGroups | length' <<<"$target_groups_json")" -eq 2 ]] || {
  echo "ALB must have exactly two target groups" >&2
  exit 1
}

backend_target_group_arn="$(jq -r '[.TargetGroups[] | select(.TargetType == "ip" and .Protocol == "HTTP" and .HealthCheckPath == "/api/health")][0].TargetGroupArn // ""' <<<"$target_groups_json")"
frontend_target_group_arn="$(jq -r '[.TargetGroups[] | select(.TargetType == "ip" and .Protocol == "HTTP" and .HealthCheckPath == "/")][0].TargetGroupArn // ""' <<<"$target_groups_json")"
[[ -n "$backend_target_group_arn" && -n "$frontend_target_group_arn" && "$backend_target_group_arn" != "$frontend_target_group_arn" ]] || {
  echo "ALB target group service/port/health-path contract drifted" >&2
  exit 1
}

jq -e --arg target "$backend_target_group_arn" '
  any(.Rules[];
    any(.Conditions[]?; .Field == "path-pattern" and any(.Values[]?; . == "/api" or . == "/api/*"))
    and any(.Actions[]?; .TargetGroupArn == $target or any(.ForwardConfig.TargetGroups[]?; .TargetGroupArn == $target))
  )
' <<<"$rules_json" >/dev/null || {
  echo "ALB /api listener rule does not target the Backend target group" >&2
  exit 1
}
jq -e --arg target "$frontend_target_group_arn" '
  any(.Rules[];
    any(.Conditions[]?; .Field == "path-pattern" and any(.Values[]?; . == "/" or . == "/*"))
    and any(.Actions[]?; .TargetGroupArn == $target or any(.ForwardConfig.TargetGroups[]?; .TargetGroupArn == $target))
  )
' <<<"$rules_json" >/dev/null || {
  echo "ALB / listener rule does not target the Frontend target group" >&2
  exit 1
}

healthy_targets=0
draining_targets=0
for service_and_target in \
  "fastapi"$'\t'"8080"$'\t'"$backend_target_group_arn" \
  "frontend"$'\t'"80"$'\t'"$frontend_target_group_arn"; do
  service="${service_and_target%%$'\t'*}"
  remaining="${service_and_target#*$'\t'}"
  expected_port="${remaining%%$'\t'*}"
  target_group_arn="${remaining#*$'\t'}"
  target_health_json="$(aws elbv2 describe-target-health \
    --region "$REGION" --target-group-arn "$target_group_arn" --output json)"
  group_healthy="$(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State == "healthy")] | length' <<<"$target_health_json")"
  group_draining="$(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State == "draining")] | length' <<<"$target_health_json")"
  group_forbidden="$(jq '[.TargetHealthDescriptions[] | select(.TargetHealth.State != "healthy" and .TargetHealth.State != "draining")] | length' <<<"$target_health_json")"
  jq -e --argjson port "$expected_port" 'all(.TargetHealthDescriptions[]; .Target.Port == $port)' \
    <<<"$target_health_json" >/dev/null || {
    echo "ALB target ports do not match the Service contract" >&2
    exit 1
  }
  [[ "$group_healthy" -ge 2 && "$group_forbidden" -eq 0 ]] || {
    echo "ALB target group does not satisfy the healthy rollout floor" >&2
    exit 1
  }

  if [[ "$MODE" == "--steady" ]]; then
    [[ "$group_draining" -eq 0 ]] || {
      echo "steady verification does not allow draining ALB targets" >&2
      exit 1
    }
    expected_ips="$(ready_endpoint_ips "$service")"
    healthy_ips="$(jq -r '.TargetHealthDescriptions[] | select(.TargetHealth.State == "healthy") | .Target.Id' <<<"$target_health_json" | LC_ALL=C sort -u)"
    [[ -n "$expected_ips" && "$healthy_ips" == "$expected_ips" ]] || {
      echo "steady ALB targets do not exactly match Ready EndpointSlice addresses" >&2
      exit 1
    }
  fi

  healthy_targets=$((healthy_targets + group_healthy))
  draining_targets=$((draining_targets + group_draining))
done

frontend_status="$(curl -sS -o "$FRONTEND_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 20 "http://$frontend_host/")"
backend_status="$(curl -sS -o "$BACKEND_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 20 "http://$backend_host/api/health")"
database_ok="$(jq -r '.database.ok == true' "$BACKEND_BODY")"
[[ "$frontend_status" == "200" && "$backend_status" == "200" && "$database_ok" == "true" ]] || {
  echo "ALB frontend or Backend/RDS health smoke failed" >&2
  exit 1
}

jq -n \
  --arg mode "${MODE#--}" \
  --argjson ingressCount "$ingress_count" \
  --arg albState "$load_balancer_state" \
  --argjson availabilityZoneCount "$availability_zone_count" \
  --argjson healthyTargets "$healthy_targets" \
  --argjson drainingTargets "$draining_targets" \
  --argjson frontendHttpStatus "$frontend_status" \
  --argjson backendHttpStatus "$backend_status" \
  --argjson databaseOk "$database_ok" \
  '{mode:$mode,ingressCount:$ingressCount,sharedAlb:true,albState:$albState,availabilityZoneCount:$availabilityZoneCount,targetGroupCount:2,healthyTargets:$healthyTargets,drainingTargets:$drainingTargets,frontendHttpStatus:$frontendHttpStatus,backendHttpStatus:$backendHttpStatus,backendDatabaseOk:$databaseOk}'
