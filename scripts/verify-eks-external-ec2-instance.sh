#!/usr/bin/env bash

set -euo pipefail
set +x

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
INSTANCE_ID="${ASKLAKE_EXPECTED_EC2_INSTANCE_ID:-}"

command -v aws >/dev/null 2>&1 || {
  echo "missing required command: aws" >&2
  exit 1
}
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || {
  echo "ASKLAKE_EXPECTED_EC2_INSTANCE_ID must identify the preserved EC2 instance" >&2
  exit 1
}

instance_state="$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)"
[[ "$instance_state" == "running" ]] || {
  echo "the expected EC2 instance is not running" >&2
  exit 1
}

instance_status="$(aws ec2 describe-instance-status \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --include-all-instances \
  --query 'InstanceStatuses[0].[InstanceStatus.Status,SystemStatus.Status]' \
  --output text)"
[[ "$instance_status" == $'ok\tok' || "$instance_status" == "ok ok" ]] || {
  echo "the expected EC2 instance or system status check is not ok" >&2
  exit 1
}

echo "external_ec2_instance_state=running"
echo "external_ec2_status_checks=ok"
