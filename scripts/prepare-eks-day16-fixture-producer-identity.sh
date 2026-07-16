#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
ROLE_NAME="asklake-dev-external-fixture-producer"
POLICY_NAME="asklake-dev-external-fixture-producer"
OUTPUT="${ASKLAKE_FIXTURE_PRODUCER_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.fixture-producer-handoff.json}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws git jq; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
[[ "${ASKLAKE_FIXTURE_IDENTITY_CONFIRM:-}" == "create-external-fixture-producer-role" ]] || \
  fail "set ASKLAKE_FIXTURE_IDENTITY_CONFIRM=create-external-fixture-producer-role"
[[ -s "$STATE" ]] || fail "Terraform state is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$STATE" || fail "Terraform state must be ignored by Git"

caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
[[ "$caller_arn" == arn:aws:iam::*:user/* ]] || fail "fixture producer role bootstrap requires the current IAM user principal"
account_id="$(aws sts get-caller-identity --query Account --output text)"
policy_arn="arn:aws:iam::$account_id:policy/$POLICY_NAME"
role_arn="arn:aws:iam::$account_id:role/$ROLE_NAME"
temporary_directory="$(mktemp -d)"
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT

jq -n --arg principal "$caller_arn" '{
  Version:"2012-10-17",
  Statement:[{Sid:"AllowCurrentOperatorToAssumeFixtureRole",Effect:"Allow",Principal:{AWS:$principal},Action:"sts:AssumeRole"}]
}' >"$temporary_directory/trust.json"
jq -c '.outputs.workload_iam_policy_documents.value.external_fixture_producer | if type == "string" then fromjson else . end' \
  "$STATE" >"$temporary_directory/policy.json"
chmod 600 "$temporary_directory/trust.json" "$temporary_directory/policy.json"

jq -e '
  ([.Statement[].Sid]|sort) == (["ConnectToMskServerless","ProduceFixtureTopic","ProduceIdempotently"]|sort)
  and all(.Statement[].Effect; . == "Allow")
  and ([.Statement[].Action[]]|sort) == (["kafka-cluster:Connect","kafka-cluster:DescribeTopic","kafka-cluster:WriteData","kafka-cluster:WriteDataIdempotently"]|sort)
  and ([.Statement[]|select(.Sid=="ProduceIdempotently")][0].Resource|length) == 1
  and ([.Statement[]|select(.Sid=="ProduceIdempotently")][0].Resource[0]|test(":cluster/"))
  and ([.Statement[]|select(.Sid=="ProduceFixtureTopic")][0].Resource|length) == 1
  and ([.Statement[]|select(.Sid=="ProduceFixtureTopic")][0].Resource[0]|test(":topic/.+/asklake\\.eks-mvp\\.fixture\\.v1$"))
  and all(.Statement[].Action[]; . != "*" and . != "kafka-cluster:*")
' "$temporary_directory/policy.json" >/dev/null || fail "fixture producer policy is not least privilege"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  existing_trust="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.AssumeRolePolicyDocument' --output json)"
  [[ "$(jq -S -c . <<<"$existing_trust")" == "$(jq -S -c . "$temporary_directory/trust.json")" ]] || \
    fail "existing fixture producer role trust differs from the approved operator"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "AskLake dev external MSK fixture producer; temporary sessions only" \
    --max-session-duration 3600 \
    --assume-role-policy-document "file://$temporary_directory/trust.json" \
    --tags Key=asklake:environment,Value=dev Key=asklake:purpose,Value=external-fixture-producer >/dev/null
fi

if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
  version="$(aws iam get-policy --policy-arn "$policy_arn" --query 'Policy.DefaultVersionId' --output text)"
  existing_policy="$(aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$version" --query 'PolicyVersion.Document' --output json)"
  if [[ "$(jq -S -c . <<<"$existing_policy")" != "$(jq -S -c . "$temporary_directory/policy.json")" ]]; then
    jq -e '
      ([.Statement[].Sid]|sort) == (["ConnectToMskServerless","ProduceFixtureTopic"]|sort)
      and ([.Statement[].Action[]]|sort) == (["kafka-cluster:Connect","kafka-cluster:DescribeTopic","kafka-cluster:WriteData"]|sort)
      and all(.Statement[].Effect; . == "Allow")
    ' <<<"$existing_policy" >/dev/null || fail "existing fixture producer policy has unreviewed drift"
    versions="$(aws iam list-policy-versions --policy-arn "$policy_arn" --query 'Versions[?IsDefaultVersion==`false`].[VersionId,CreateDate]' --output json)"
    if [[ "$(jq 'length' <<<"$versions")" -ge 4 ]]; then
      oldest_version="$(jq -r 'sort_by(.[1])[0][0]' <<<"$versions")"
      aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$oldest_version"
    fi
    aws iam create-policy-version --policy-arn "$policy_arn" \
      --policy-document "file://$temporary_directory/policy.json" --set-as-default >/dev/null
  fi
else
  aws iam create-policy --policy-name "$POLICY_NAME" \
    --description "AskLake dev MSK fixture topic produce-only policy" \
    --policy-document "file://$temporary_directory/policy.json" \
    --tags Key=asklake:environment,Value=dev Key=asklake:purpose,Value=external-fixture-producer >/dev/null
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$policy_arn"
attached="$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query 'AttachedPolicies[].PolicyArn' --output json)"
[[ "$(jq 'length' <<<"$attached")" -eq 1 && "$(jq -r '.[0]' <<<"$attached")" == "$policy_arn" ]] || \
  fail "fixture producer role must have exactly the approved managed policy"
[[ "$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'length(PolicyNames)' --output text)" == "0" ]] || \
  fail "fixture producer role must not have inline policies"

jq -n --arg roleArn "$role_arn" --arg policyArn "$policy_arn" \
  --arg topic "$(jq -r '.outputs.msk_contract.value.test_topic' "$STATE")" '{
    contractVersion:"1.0",environment:"dev",authentication:"sts-assume-role",longTermAccessKey:false,
    roleArn:$roleArn,policyArn:$policyArn,topic:$topic,
    allowedActions:["kafka-cluster:Connect","kafka-cluster:DescribeTopic","kafka-cluster:WriteData","kafka-cluster:WriteDataIdempotently"]
  }' >"$OUTPUT"
chmod 600 "$OUTPUT"
echo "fixture_producer_identity=ready"
