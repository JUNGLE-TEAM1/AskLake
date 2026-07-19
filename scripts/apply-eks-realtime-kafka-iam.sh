#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-ap-northeast-2}"
GENERATION="${ASKLAKE_REALTIME_GENERATION:-}"
RECEIPT="${ASKLAKE_REALTIME_IAM_RECEIPT:-/private/tmp/asklake-1044-iam-receipt.json}"
WORK_DIR="${ASKLAKE_REALTIME_IAM_WORK_DIR:-/private/tmp/asklake-1044-iam-work}"

fail() { echo "$1" >&2; exit 1; }
[[ "${ASKLAKE_REALTIME_IAM_CONFIRM:-}" == "apply-exact-realtime-generation-iam" ]] || fail "explicit IAM confirmation is required"
[[ "$GENERATION" =~ ^[a-z0-9][a-z0-9.-]{0,40}$ ]] || fail "invalid generation"
[[ ! -e "$RECEIPT" && ! -e "$WORK_DIR" ]] || fail "refusing to overwrite private IAM evidence"
mkdir -m 700 "$WORK_DIR"
umask 077

TOPIC="asklake.eks-realtime.fixture.$GENERATION"
GROUP="asklake-eks-realtime-v1-$GENERATION"
CLUSTER="$(aws eks list-clusters --region "$REGION" --query 'clusters[0]' --output text)"

association_policy() {
  local service_account="$1" association role
  association="$(aws eks list-pod-identity-associations --region "$REGION" --cluster-name "$CLUSTER" \
    --namespace asklake-dev --service-account "$service_account" --query 'associations[0].associationId' --output text)"
  role="$(aws eks describe-pod-identity-association --region "$REGION" --cluster-name "$CLUSTER" \
    --association-id "$association" --query 'association.roleArn' --output text)"
  aws iam list-attached-role-policies --role-name "$(basename "$role")" \
    --query 'AttachedPolicies[0].PolicyArn' --output text
}

SPARK_POLICY="$(association_policy asklake-spark)"
BACKEND_POLICY="$(association_policy asklake-backend)"
PRODUCER_POLICY=""
while read -r policy_arn; do
  [[ -n "$policy_arn" ]] || continue
  version="$(aws iam get-policy --policy-arn "$policy_arn" --query 'Policy.DefaultVersionId' --output text)"
  document="$(aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$version" --query 'PolicyVersion.Document' --output json)"
  if jq -e '[.Statement[]?.Sid] | index("ProduceFixtureTopic") != null' <<<"$document" >/dev/null; then
    [[ -z "$PRODUCER_POLICY" ]] || fail "multiple fixture producer policies found"
    PRODUCER_POLICY="$policy_arn"
  fi
done < <(aws iam list-policies --scope Local --query 'Policies[].Arn' --output text | tr '\t' '\n')
[[ -n "$PRODUCER_POLICY" ]] || fail "fixture producer policy not found"

policy_for() {
  case "$1" in
    spark) printf '%s' "$SPARK_POLICY" ;;
    backend) printf '%s' "$BACKEND_POLICY" ;;
    producer) printf '%s' "$PRODUCER_POLICY" ;;
  esac
}

for name in spark backend producer; do
  policy_arn="$(policy_for "$name")"
  [[ "$(aws iam list-policy-versions --policy-arn "$policy_arn" --query 'length(Versions)' --output text)" -lt 5 ]] || \
    fail "$name policy has no free version slot"
  old_version="$(aws iam get-policy --policy-arn "$policy_arn" --query 'Policy.DefaultVersionId' --output text)"
  aws iam get-policy-version --policy-arn "$policy_arn" --version-id "$old_version" \
    --query 'PolicyVersion.Document' --output json >"$WORK_DIR/$name.old.json"
  printf '%s' "$old_version" >"$WORK_DIR/$name.old-version"
done

CLUSTER_ARN="$(jq -r '.Statement[]|select(.Sid=="ConnectToMskServerless")|.Resource|if type=="array" then .[0] else . end' "$WORK_DIR/spark.old.json")"
TOPIC_ARN="$(sed 's/:cluster\//:topic\//' <<<"$CLUSTER_ARN")/$TOPIC"
GROUP_ARN="$(sed 's/:cluster\//:group\//' <<<"$CLUSTER_ARN")/$GROUP"
OUTPUT_BUCKET_ARN="$(jq -r '.Statement[]|select(.Sid=="ListBackendOutputBucket")|.Resource|if type=="array" then .[0] else . end' "$WORK_DIR/backend.old.json")"
RUNTIME_OBJECT_ARN="$OUTPUT_BUCKET_ARN/continuous-runtime/*"

jq --arg topic "$TOPIC_ARN" --arg group "$GROUP_ARN" '
  def arr: if type=="array" then . else [.] end;
  .Statement |= map(
    if .Sid=="ConsumeFixtureTopic" then .Resource=((.Resource|arr)+[$topic]|unique)
    elif .Sid=="UseFixtureConsumerGroup" then .Resource=((.Resource|arr)+[$group]|unique)
    else . end
  )' "$WORK_DIR/spark.old.json" >"$WORK_DIR/spark.new.json"

jq --arg runtime "$RUNTIME_OBJECT_ARN" '
  def arr: if type=="array" then . else [.] end;
  .Statement |= map(
    if .Sid=="ListBackendOutputBucket" then
      .Condition.StringLike["s3:prefix"]=((.Condition.StringLike["s3:prefix"]|arr)+["continuous-runtime","continuous-runtime/*"]|unique)
    elif .Sid=="ReadBackendObjects" or .Sid=="WriteBackendResultsAndEvidence" then
      .Resource=((.Resource|arr)+[$runtime]|unique)
    else . end
  )' "$WORK_DIR/backend.old.json" >"$WORK_DIR/backend.new.json"

jq --arg topic "$TOPIC_ARN" '
  def arr: if type=="array" then . else [.] end;
  .Statement |= map(if .Sid=="ProduceFixtureTopic" then .Resource=((.Resource|arr)+[$topic]|unique) else . end)
  ' "$WORK_DIR/producer.old.json" >"$WORK_DIR/producer.new.json"

APPLIED=""
rollback_partial() {
  for name in $APPLIED; do
    aws iam set-default-policy-version --policy-arn "$(policy_for "$name")" \
      --version-id "$(<"$WORK_DIR/$name.old-version")" >/dev/null 2>&1 || true
  done
}
trap rollback_partial ERR
for name in spark backend producer; do
  new_version="$(aws iam create-policy-version --policy-arn "$(policy_for "$name")" \
    --policy-document "file://$WORK_DIR/$name.new.json" --set-as-default \
    --query 'PolicyVersion.VersionId' --output text)"
  printf '%s' "$new_version" >"$WORK_DIR/$name.new-version"
  APPLIED="$APPLIED $name"
done
trap - ERR

jq -n --arg generation "$GENERATION" \
  --arg topicHash "$(printf '%s' "$TOPIC" | shasum -a 256 | awk '{print $1}')" \
  --arg groupHash "$(printf '%s' "$GROUP" | shasum -a 256 | awk '{print $1}')" \
  --arg runtimeHash "$(printf '%s' "$RUNTIME_OBJECT_ARN" | shasum -a 256 | awk '{print $1}')" \
  --arg runtimeObjectArn "$RUNTIME_OBJECT_ARN" \
  --arg sparkOld "$(<"$WORK_DIR/spark.old-version")" --arg sparkNew "$(<"$WORK_DIR/spark.new-version")" \
  --arg backendOld "$(<"$WORK_DIR/backend.old-version")" --arg backendNew "$(<"$WORK_DIR/backend.new-version")" \
  --arg producerOld "$(<"$WORK_DIR/producer.old-version")" --arg producerNew "$(<"$WORK_DIR/producer.new-version")" \
  '{schemaVersion:1,status:"applied",generation:$generation,runtimeObjectArn:$runtimeObjectArn,
    identityHashes:{topic:$topicHash,group:$groupHash,runtimeObject:$runtimeHash},
    policyVersions:{spark:{previous:$sparkOld,current:$sparkNew},backend:{previous:$backendOld,current:$backendNew},producer:{previous:$producerOld,current:$producerNew}}}' \
  >"$RECEIPT"
chmod 600 "$RECEIPT"
echo "iam_policy_versions_applied=3"
echo "generation=$GENERATION"
echo "private_receipt_mode=600"
