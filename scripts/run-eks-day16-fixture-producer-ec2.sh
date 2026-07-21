#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
HANDOFF="${ASKLAKE_FIXTURE_PRODUCER_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.fixture-producer-handoff.json}"
OUTPUT="${ASKLAKE_FIXTURE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.fixture-receipt.json}"
PRODUCER="$ROOT_DIR/backend/scripts/produce-eks-msk-fixture.mjs"
IMDS_READER="$ROOT_DIR/backend/scripts/read-ec2-imds-credentials.mjs"
PRODUCER_PACKAGE="$ROOT_DIR/backend/fixture-producer/package.json"
PRODUCER_LOCK="$ROOT_DIR/backend/fixture-producer/package-lock.json"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXPECTED_COUNT="${ASKLAKE_FIXTURE_EXPECTED_COUNT:-100}"
BATCH_ID="${ASKLAKE_FIXTURE_BATCH_ID:-eks-mvp-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)}"
HOST_ROLE="asklake-dev-fixture-host"
HOST_PROFILE="asklake-dev-fixture-host"
INSTANCE_ID=""
FIXTURE_SECURITY_GROUP_ID=""
MSK_SECURITY_GROUP_ID=""
MSK_INGRESS_CREATED=0
HOST_CREATED=0

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws base64 git gzip jq node openssl tar; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
[[ "${ASKLAKE_FIXTURE_EC2_CONFIRM:-}" == "run-temporary-private-fixture-host" ]] || \
  fail "set ASKLAKE_FIXTURE_EC2_CONFIRM=run-temporary-private-fixture-host"
for file in "$STATE" "$HANDOFF" "$PRODUCER" "$IMDS_READER" "$PRODUCER_PACKAGE" "$PRODUCER_LOCK"; do [[ -s "$file" ]] || fail "fixture host input is missing"; done
[[ ! -e "$OUTPUT" ]] || fail "fixture receipt already exists; do not overwrite it"
git -C "$ROOT_DIR" check-ignore -q -- "$STATE"
git -C "$ROOT_DIR" check-ignore -q -- "$HANDOFF"

caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
[[ "$caller_arn" == arn:aws:iam::*:user/* ]] || fail "temporary host bootstrap requires the current IAM user"
account_id="$(aws sts get-caller-identity --query Account --output text)"
producer_role_arn="$(jq -r '.roleArn' "$HANDOFF")"
producer_policy_arn="$(jq -r '.policyArn' "$HANDOFF")"
producer_topic="$(jq -r '.topic' "$HANDOFF")"
[[ "$producer_role_arn" == "arn:aws:iam::$account_id:role/asklake-dev-external-fixture-producer" ]] || \
  fail "producer role account or name is invalid"
[[ "$producer_policy_arn" == "arn:aws:iam::$account_id:policy/asklake-dev-external-fixture-producer" ]] || \
  fail "producer policy account or name is invalid"
[[ "$producer_topic" == "$(jq -r '.outputs.msk_contract.value.test_topic' "$STATE")" ]] || fail "fixture topic drifted"

temporary_directory="$(mktemp -d)"
retry_cleanup() {
  local attempts=0
  until "$@" >/dev/null 2>&1; do
    attempts=$((attempts+1))
    [[ "$attempts" -lt 10 ]] || return 1
    sleep 3
  done
}
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$INSTANCE_ID" ]]; then
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 || status=1
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 || status=1
  fi
  if [[ "$HOST_CREATED" -eq 1 ]]; then
    aws iam remove-role-from-instance-profile --instance-profile-name "$HOST_PROFILE" --role-name "$HOST_ROLE" >/dev/null 2>&1 || true
    retry_cleanup aws iam delete-instance-profile --instance-profile-name "$HOST_PROFILE" || status=1
    aws iam detach-role-policy --role-name "$HOST_ROLE" --policy-arn "$producer_policy_arn" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "$HOST_ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true
    retry_cleanup aws iam delete-role --role-name "$HOST_ROLE" || status=1
  fi
  if [[ "$MSK_INGRESS_CREATED" -eq 1 ]]; then
    retry_cleanup aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$MSK_SECURITY_GROUP_ID" \
      --ip-permissions "IpProtocol=tcp,FromPort=9098,ToPort=9098,UserIdGroupPairs=[{GroupId=$FIXTURE_SECURITY_GROUP_ID}]" || status=1
  fi
  if [[ -n "$FIXTURE_SECURITY_GROUP_ID" ]]; then
    retry_cleanup aws ec2 delete-security-group --region "$REGION" --group-id "$FIXTURE_SECURITY_GROUP_ID" || status=1
  fi
  aws iam get-role --role-name "$HOST_ROLE" >/dev/null 2>&1 && status=1
  aws iam get-instance-profile --instance-profile-name "$HOST_PROFILE" >/dev/null 2>&1 && status=1
  if [[ -n "$FIXTURE_SECURITY_GROUP_ID" ]]; then
    aws ec2 describe-security-groups --region "$REGION" --group-ids "$FIXTURE_SECURITY_GROUP_ID" >/dev/null 2>&1 && status=1
  fi
  rm -rf "$temporary_directory"
  exit "$status"
}
trap cleanup EXIT

if aws iam get-role --role-name "$HOST_ROLE" >/dev/null 2>&1 \
  || aws iam get-instance-profile --instance-profile-name "$HOST_PROFILE" >/dev/null 2>&1; then
  fail "temporary fixture host IAM residue already exists"
fi

jq -n '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"ec2.amazonaws.com"},Action:"sts:AssumeRole"}]}' \
  >"$temporary_directory/host-trust.json"
chmod 600 "$temporary_directory/host-trust.json"
aws iam create-role --role-name "$HOST_ROLE" --description "Temporary AskLake private fixture execution host" \
  --assume-role-policy-document "file://$temporary_directory/host-trust.json" >/dev/null
HOST_CREATED=1
aws iam attach-role-policy --role-name "$HOST_ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name "$HOST_ROLE" --policy-arn "$producer_policy_arn"
aws iam create-instance-profile --instance-profile-name "$HOST_PROFILE" >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name "$HOST_PROFILE" --role-name "$HOST_ROLE"
profile_ready=false
for _ in $(seq 1 30); do
  if [[ "$(aws iam get-instance-profile --instance-profile-name "$HOST_PROFILE" --query 'InstanceProfile.Roles[0].RoleName' --output text 2>/dev/null || true)" == "$HOST_ROLE" ]]; then
    profile_ready=true
    break
  fi
  sleep 2
done
[[ "$profile_ready" == "true" ]] || fail "temporary host instance profile did not become ready"

cluster_arn="$(jq -r '.outputs.msk_contract.value.cluster_arn' "$STATE")"
topic_arn="$(jq -r '.outputs.workload_iam_policy_documents.value.external_fixture_producer|fromjson|.Statement[]|select(.Sid=="ProduceFixtureTopic")|.Resource[0]' "$STATE")"
host_policy_ready=false
for _ in $(seq 1 30); do
  cluster_decisions="$(aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$account_id:role/$HOST_ROLE" \
    --action-names kafka-cluster:Connect kafka-cluster:WriteDataIdempotently --resource-arns "$cluster_arn" \
    --query 'EvaluationResults[].EvalDecision' --output json 2>/dev/null || true)"
  topic_decisions="$(aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$account_id:role/$HOST_ROLE" \
    --action-names kafka-cluster:DescribeTopic kafka-cluster:WriteData --resource-arns "$topic_arn" \
    --query 'EvaluationResults[].EvalDecision' --output json 2>/dev/null || true)"
  ssm_decision="$(aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$account_id:role/$HOST_ROLE" \
    --action-names ssm:UpdateInstanceInformation --resource-arns '*' \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || true)"
  if jq -e 'length==2 and all(.[];.=="allowed")' <<<"$cluster_decisions" >/dev/null 2>&1 \
    && jq -e 'length==2 and all(.[];.=="allowed")' <<<"$topic_decisions" >/dev/null 2>&1 \
    && [[ "$ssm_decision" == "allowed" ]]; then
    host_policy_ready=true
    break
  fi
  sleep 2
done
[[ "$host_policy_ready" == "true" ]] || fail "temporary host producer policy did not become ready"
sleep 30

subnet_id="$(jq -r '.outputs.phase11_network_handoff.value.subnets.cluster_private[0]' "$STATE")"
vpc_id="$(jq -r '.outputs.phase11_network_handoff.value.vpc_id' "$STATE")"
MSK_SECURITY_GROUP_ID="$(jq -r '.outputs.phase11_network_handoff.value.service_security_groups.msk' "$STATE")"
vpc_cidr="$(aws ec2 describe-vpcs --region "$REGION" --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text)"
ami_id="$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)"
[[ -n "$subnet_id" && -n "$vpc_id" && -n "$MSK_SECURITY_GROUP_ID" && -n "$vpc_cidr" && -n "$ami_id" ]] || fail "temporary host network or AMI input is missing"

FIXTURE_SECURITY_GROUP_ID="$(aws ec2 create-security-group --region "$REGION" --vpc-id "$vpc_id" \
  --group-name "asklake-dev-fixture-host-$(openssl rand -hex 4)" \
  --description "Temporary no-ingress fixture producer host" --query GroupId --output text)"
aws ec2 revoke-security-group-egress --region "$REGION" --group-id "$FIXTURE_SECURITY_GROUP_ID" \
  --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
aws ec2 authorize-security-group-egress --region "$REGION" --group-id "$FIXTURE_SECURITY_GROUP_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=9098,ToPort=9098,UserIdGroupPairs=[{GroupId=$MSK_SECURITY_GROUP_ID}]" \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  "IpProtocol=tcp,FromPort=53,ToPort=53,IpRanges=[{CidrIp=$vpc_cidr}]" \
  "IpProtocol=udp,FromPort=53,ToPort=53,IpRanges=[{CidrIp=$vpc_cidr}]" >/dev/null
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$MSK_SECURITY_GROUP_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=9098,ToPort=9098,UserIdGroupPairs=[{GroupId=$FIXTURE_SECURITY_GROUP_ID}]" >/dev/null
MSK_INGRESS_CREATED=1

for _ in 1 2 3 4 5; do
  if INSTANCE_ID="$(aws ec2 run-instances --region "$REGION" --image-id "$ami_id" --instance-type t3.micro \
    --subnet-id "$subnet_id" --security-group-ids "$FIXTURE_SECURITY_GROUP_ID" \
    --iam-instance-profile Name="$HOST_PROFILE" --no-associate-public-ip-address \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=asklake-dev-fixture-host},{Key=asklake:temporary,Value=true}]' \
    --query 'Instances[0].InstanceId' --output text 2>/dev/null)"; then break; fi
  sleep 3
done
[[ -n "$INSTANCE_ID" ]] || fail "unable to create temporary fixture host"
aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$INSTANCE_ID"
profile_association_id="$(aws ec2 describe-iam-instance-profile-associations --region "$REGION" \
  --filters "Name=instance-id,Values=$INSTANCE_ID" --query 'IamInstanceProfileAssociations[0].AssociationId' --output text)"
[[ -n "$profile_association_id" && "$profile_association_id" != "None" ]] || fail "temporary host instance profile association is missing"
aws ec2 replace-iam-instance-profile-association --region "$REGION" \
  --association-id "$profile_association_id" --iam-instance-profile Name="$HOST_PROFILE" >/dev/null
sleep 30

ssm_online=false
for _ in $(seq 1 120); do
  if aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$INSTANCE_ID" --output json \
    | jq -e '(.InstanceInformationList|length)==1 and .InstanceInformationList[0].PingStatus=="Online"' >/dev/null; then
    ssm_online=true; break
  fi
  sleep 2
done
[[ "$ssm_online" == "true" ]] || fail "temporary fixture host did not register with SSM"

mkdir -p "$temporary_directory/producer-package"
cp "$PRODUCER" "$temporary_directory/producer-package/produce.mjs"
cp "$IMDS_READER" "$temporary_directory/producer-package/read-imds.mjs"
cp "$PRODUCER_PACKAGE" "$temporary_directory/producer-package/package.json"
cp "$PRODUCER_LOCK" "$temporary_directory/producer-package/package-lock.json"
tar -C "$temporary_directory/producer-package" -czf "$temporary_directory/producer-package.tar.gz" .
producer_archive_base64="$(base64 <"$temporary_directory/producer-package.tar.gz" | tr -d '\n')"
brokers="$(jq -r '.outputs.msk_contract.value.bootstrap_brokers_sasl_iam' "$STATE")"
remote_script="$(cat <<EOF
set -euo pipefail
step=bootstrap
trap 'printf "fixture_private_host_failure_step=%s\n" "\$step" >&2' ERR
step=packages
dnf install -y nodejs npm >/dev/null
command -v aws >/dev/null && command -v node >/dev/null && command -v npm >/dev/null
work=/tmp/asklake-fixture
rm -rf "\$work" && mkdir -p "\$work" && cd "\$work"
printf '%s' '$producer_archive_base64' | base64 -d | tar -xzf -
step=dependencies
if ! npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/tmp/asklake-fixture-npm.log 2>&1; then
  reason=UNKNOWN
  if grep -Eqi 'ENOTFOUND|EAI_AGAIN|network' /tmp/asklake-fixture-npm.log; then reason=NETWORK; fi
  if grep -Eqi 'ENOSPC|no space' /tmp/asklake-fixture-npm.log; then reason=DISK; fi
  if grep -Eqi 'certificate|CERT_' /tmp/asklake-fixture-npm.log; then reason=CERTIFICATE; fi
  if grep -Eqi 'notarget|No matching version' /tmp/asklake-fixture-npm.log; then reason=VERSION; fi
  if grep -Eqi 'EACCES|permission denied' /tmp/asklake-fixture-npm.log; then reason=PERMISSION; fi
  printf 'fixture_dependency_failure=%s\n' "\$reason" >&2
  false
fi
step=identity
credentials_file="\$work/instance-profile-credentials.json"
node read-imds.mjs '$HOST_ROLE' "\$credentials_file"
export AWS_ACCESS_KEY_ID="\$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.AccessKeyId)' "\$credentials_file")"
export AWS_SECRET_ACCESS_KEY="\$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.SecretAccessKey)' "\$credentials_file")"
export AWS_SESSION_TOKEN="\$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.Token)' "\$credentials_file")"
rm -f "\$credentials_file"
[[ "\$(aws sts get-caller-identity --query Arn --output text)" == arn:aws:sts::*:assumed-role/$HOST_ROLE/* ]]
export AWS_REGION='$REGION' ASKLAKE_KAFKA_BROKER='$brokers' ASKLAKE_FIXTURE_TOPIC='$producer_topic'
export ASKLAKE_FIXTURE_BATCH_ID='$BATCH_ID' ASKLAKE_FIXTURE_EXPECTED_COUNT='$EXPECTED_COUNT'
step=producer
node produce.mjs
step=cleanup
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
rm -rf "\$work"
EOF
)"
remote_script_base64="$(printf '%s' "$remote_script" | base64 | tr -d '\n')"
ssm_command="printf '%s' '$remote_script_base64' | base64 -d | bash"
[[ "${#ssm_command}" -le 24000 ]] || fail "temporary fixture command exceeds the SSM command size boundary"
ssm_parameters="$(jq -nc --arg command "$ssm_command" '{commands:[$command]}')"
command_id="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --parameters "$ssm_parameters" --timeout-seconds 600 \
  --query 'Command.CommandId' --output text)"
invocation_status=""
for _ in $(seq 1 180); do
  invocation_status="$(aws ssm get-command-invocation --region "$REGION" --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || true)"
  case "$invocation_status" in Success|Failed|TimedOut|Cancelled) break;; esac
  sleep 2
done
if [[ "$invocation_status" != "Success" ]]; then
  failure_output="$(aws ssm get-command-invocation --region "$REGION" --command-id "$command_id" \
    --instance-id "$INSTANCE_ID" --query StandardErrorContent --output text 2>/dev/null || true)"
  failure_step="$(printf '%s\n' "$failure_output" | awk -F= '/^fixture_private_host_failure_step=/{print $2}' | tail -1)"
  dependency_reason="$(printf '%s\n' "$failure_output" | awk -F= '/^fixture_dependency_failure=/{print $2}' | tail -1)"
  [[ -n "$failure_step" ]] && echo "fixture_private_host_failure_step=$failure_step" >&2
  [[ -n "$dependency_reason" ]] && echo "fixture_dependency_failure=$dependency_reason" >&2
  fail "temporary private fixture producer command failed"
fi
receipt="$(aws ssm get-command-invocation --region "$REGION" --command-id "$command_id" \
  --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text)"
jq -e --arg batch "$BATCH_ID" --arg topic "$producer_topic" --argjson count "$EXPECTED_COUNT" '
  .contractVersion=="1.0" and .batchId==$batch and .topic==$topic
  and .expectedCount==$count and .producedCount==$count
  and (.payloadSha256|test("^[0-9a-f]{64}$")) and .sequence=={first:1,last:$count}
  and (.partitionsAcknowledged>=1)
' <<<"$receipt" >/dev/null || fail "temporary fixture receipt is invalid"
printf '%s\n' "$receipt" >"$OUTPUT"
chmod 600 "$OUTPUT"
echo "fixture_private_host=passed expected_count=$EXPECTED_COUNT"
