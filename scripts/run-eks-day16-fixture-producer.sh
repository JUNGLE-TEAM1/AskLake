#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
HANDOFF="${ASKLAKE_FIXTURE_PRODUCER_HANDOFF:-$ROOT_DIR/infra/eks/delivery/dev.fixture-producer-handoff.json}"
OUTPUT="${ASKLAKE_FIXTURE_RECEIPT:-$ROOT_DIR/infra/eks/delivery/dev.fixture-receipt.json}"
PRODUCER="$ROOT_DIR/backend/scripts/produce-eks-msk-fixture.mjs"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXPECTED_COUNT="${ASKLAKE_FIXTURE_EXPECTED_COUNT:-100}"
BATCH_ID="${ASKLAKE_FIXTURE_BATCH_ID:-eks-mvp-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)}"

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws git jq node openssl; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
[[ "${ASKLAKE_FIXTURE_PRODUCE_CONFIRM:-}" == "produce-isolated-msk-fixture" ]] || \
  fail "set ASKLAKE_FIXTURE_PRODUCE_CONFIRM=produce-isolated-msk-fixture"
for file in "$STATE" "$HANDOFF" "$PRODUCER"; do [[ -s "$file" ]] || fail "fixture producer input is missing"; done
git -C "$ROOT_DIR" check-ignore -q -- "$STATE" || fail "Terraform state must be ignored"
git -C "$ROOT_DIR" check-ignore -q -- "$HANDOFF" || fail "fixture handoff must be ignored"
[[ ! -e "$OUTPUT" ]] || fail "fixture receipt already exists; do not overwrite a produced batch receipt"
[[ "$EXPECTED_COUNT" =~ ^[0-9]+$ && "$EXPECTED_COUNT" -ge 1 && "$EXPECTED_COUNT" -le 10000 ]] || fail "fixture count is out of range"
[[ "$BATCH_ID" =~ ^eks-mvp-[a-z0-9-]{8,80}$ ]] || fail "fixture batch ID is invalid"

role_arn="$(jq -r '.roleArn' "$HANDOFF")"
policy_arn="$(jq -r '.policyArn' "$HANDOFF")"
topic="$(jq -r '.topic' "$HANDOFF")"
jq -e --arg topic "$(jq -r '.outputs.msk_contract.value.test_topic' "$STATE")" '
  .contractVersion == "1.0"
  and .environment == "dev"
  and .authentication == "sts-assume-role"
  and .longTermAccessKey == false
  and .topic == $topic
  and (.roleArn|test("^arn:aws:iam::[0-9]{12}:role/asklake-dev-external-fixture-producer$"))
  and (.policyArn|test("^arn:aws:iam::[0-9]{12}:policy/asklake-dev-external-fixture-producer$"))
  and (.allowedActions|sort) == (["kafka-cluster:Connect","kafka-cluster:DescribeTopic","kafka-cluster:WriteData","kafka-cluster:WriteDataIdempotently"]|sort)
' "$HANDOFF" >/dev/null || fail "fixture producer handoff is invalid"

role_name="${role_arn##*/}"
attached="$(aws iam list-attached-role-policies --role-name "$role_name" --query 'AttachedPolicies[].PolicyArn' --output json)"
[[ "$(jq 'length' <<<"$attached")" -eq 1 && "$(jq -r '.[0]' <<<"$attached")" == "$policy_arn" ]] || \
  fail "fixture producer role attachment drifted"
[[ "$(aws iam list-role-policies --role-name "$role_name" --query 'length(PolicyNames)' --output text)" == "0" ]] || \
  fail "fixture producer role gained an inline policy"
version="$(aws iam get-policy --policy-arn "$policy_arn" --query 'Policy.DefaultVersionId' --output text)"
policy_json="$(aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$version" --query 'PolicyVersion.Document' --output json)"
expected_policy="$(jq -r '.outputs.workload_iam_policy_documents.value.external_fixture_producer' "$STATE")"
[[ "$(jq -S -c . <<<"$policy_json")" == "$(jq -S -c . <<<"$expected_policy")" ]] || \
  fail "fixture producer policy differs from Terraform contract"

temporary_directory="$(mktemp -d)"
cleanup() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

credentials=""
for _ in 1 2 3 4 5; do
  if credentials="$(aws sts assume-role --role-arn "$role_arn" \
    --role-session-name "asklake-fixture-$(date -u +%H%M%S)" --duration-seconds 3600 --output json 2>/dev/null)"; then
    break
  fi
  sleep 2
done
[[ -n "$credentials" ]] || fail "unable to assume the external fixture producer role"
export AWS_ACCESS_KEY_ID="$(jq -r '.Credentials.AccessKeyId' <<<"$credentials")"
export AWS_SECRET_ACCESS_KEY="$(jq -r '.Credentials.SecretAccessKey' <<<"$credentials")"
export AWS_SESSION_TOKEN="$(jq -r '.Credentials.SessionToken' <<<"$credentials")"
unset credentials

assumed_arn="$(aws sts get-caller-identity --query Arn --output text)"
[[ "$assumed_arn" == arn:aws:sts::*:assumed-role/asklake-dev-external-fixture-producer/* ]] || \
  fail "temporary fixture credentials are not the approved role session"

export AWS_REGION="$REGION"
export ASKLAKE_KAFKA_BROKER="$(jq -r '.outputs.msk_contract.value.bootstrap_brokers_sasl_iam' "$STATE")"
export ASKLAKE_FIXTURE_TOPIC="$topic"
export ASKLAKE_FIXTURE_BATCH_ID="$BATCH_ID"
export ASKLAKE_FIXTURE_EXPECTED_COUNT="$EXPECTED_COUNT"

temporary_receipt="$temporary_directory/fixture-receipt.json"
if ! node "$PRODUCER" >"$temporary_receipt" 2>"$temporary_directory/producer-error.log"; then
  jq -c 'select(.status=="failed") | {status,name,code,causeName,causeCode,category}' "$temporary_directory/producer-error.log" 2>/dev/null | tail -1 >&2 || true
  fail "external fixture producer failed without publishing a receipt"
fi
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN ASKLAKE_KAFKA_BROKER

jq -e --arg batch "$BATCH_ID" --arg topic "$topic" --argjson count "$EXPECTED_COUNT" '
  .contractVersion == "1.0"
  and .batchId == $batch
  and .topic == $topic
  and .expectedCount == $count
  and .producedCount == $count
  and (.payloadSha256|test("^[0-9a-f]{64}$"))
  and .sequence == {first:1,last:$count}
  and (.partitionsAcknowledged|type=="number" and . >= 1)
' "$temporary_receipt" >/dev/null || fail "fixture producer receipt is invalid"
mv "$temporary_receipt" "$OUTPUT"
chmod 600 "$OUTPUT"
echo "fixture_producer=passed expected_count=$EXPECTED_COUNT"
