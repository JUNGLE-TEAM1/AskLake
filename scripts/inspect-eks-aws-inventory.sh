#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-ap-northeast-2}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "sts_auth=failed"
  exit 1
fi

echo "sts_auth=ok"
echo "configured_region=$REGION"

probe_count() {
  local label="$1"
  shift

  local output_file="$TMP_DIR/${label}.out"
  local error_file="$TMP_DIR/${label}.err"

  if "$@" >"$output_file" 2>"$error_file"; then
    local count
    count="$(tr -d '[:space:]' <"$output_file")"
    if [[ "$count" =~ ^[0-9]+$ ]]; then
      echo "$label=ok count:$count"
    else
      echo "$label=error"
    fi
    return
  fi

  local error_text
  error_text="$(<"$error_file")"
  if [[ "$error_text" == *"AccessDenied"* || "$error_text" == *"UnauthorizedOperation"* || "$error_text" == *"not authorized"* ]]; then
    echo "$label=access_denied"
  elif [[ "$error_text" == *"ExpiredToken"* || "$error_text" == *"InvalidClientTokenId"* || "$error_text" == *"Unable to locate credentials"* ]]; then
    echo "$label=auth_error"
  else
    echo "$label=error"
  fi
}

probe_count eks_clusters \
  aws eks list-clusters --region "$REGION" --query 'length(clusters)' --output text
probe_count ecr_repositories \
  aws ecr describe-repositories --region "$REGION" --query 'length(repositories)' --output text
probe_count msk_clusters \
  aws kafka list-clusters-v2 --region "$REGION" --query 'length(ClusterInfoList)' --output text
probe_count rds_instances \
  aws rds describe-db-instances --region "$REGION" --query 'length(DBInstances)' --output text
probe_count vpcs \
  aws ec2 describe-vpcs --region "$REGION" --query 'length(Vpcs)' --output text
probe_count default_vpcs \
  aws ec2 describe-vpcs --region "$REGION" --query 'length(Vpcs[?IsDefault==`true`])' --output text
probe_count subnets \
  aws ec2 describe-subnets --region "$REGION" --query 'length(Subnets)' --output text
probe_count public_ip_subnets \
  aws ec2 describe-subnets --region "$REGION" --query 'length(Subnets[?MapPublicIpOnLaunch==`true`])' --output text
probe_count private_ip_subnets \
  aws ec2 describe-subnets --region "$REGION" --query 'length(Subnets[?MapPublicIpOnLaunch==`false`])' --output text
probe_count nat_gateways \
  aws ec2 describe-nat-gateways --region "$REGION" --query 'length(NatGateways)' --output text
probe_count vpc_endpoints \
  aws ec2 describe-vpc-endpoints --region "$REGION" --query 'length(VpcEndpoints)' --output text
probe_count internet_gateways \
  aws ec2 describe-internet-gateways --region "$REGION" --query 'length(InternetGateways)' --output text
probe_count route_tables \
  aws ec2 describe-route-tables --region "$REGION" --query 'length(RouteTables)' --output text
probe_count security_groups \
  aws ec2 describe-security-groups --region "$REGION" --query 'length(SecurityGroups)' --output text
probe_count running_instances \
  aws ec2 describe-instances --region "$REGION" \
    --filters Name=instance-state-name,Values=running \
    --query 'length(Reservations[].Instances[])' --output text
probe_count load_balancers \
  aws elbv2 describe-load-balancers --region "$REGION" --query 'length(LoadBalancers)' --output text
probe_count acm_certificates \
  aws acm list-certificates --region "$REGION" --query 'length(CertificateSummaryList)' --output text
probe_count route53_zones \
  aws route53 list-hosted-zones --query 'length(HostedZones)' --output text
probe_count s3_buckets \
  aws s3api list-buckets --query 'length(Buckets)' --output text
probe_count secrets \
  aws secretsmanager list-secrets --region "$REGION" --query 'length(SecretList)' --output text
