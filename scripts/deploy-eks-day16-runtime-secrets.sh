#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
INPUT="${ASKLAKE_DAY16_SECRET_INPUT:-$ROOT_DIR/infra/eks/secrets/dev.runtime-secret-input.json}"
SPARK_MANIFEST="$ROOT_DIR/infra/eks/secrets/spark-runtime-external-secret.yaml"
TRINO_MANIFEST="$ROOT_DIR/infra/eks/secrets/trino-runtime-external-secret.yaml"
RUN_TOKEN="$(date -u +%s)-$$-${RANDOM}"
SPARK_STAGE="asklake-spark-runtime-stage-$RUN_TOKEN"
TRINO_STAGE="asklake-trino-runtime-stage-$RUN_TOKEN"
SPARK_SOURCE_CREATED=0
TRINO_SOURCE_CREATED=0
SPARK_FINAL_CREATED=0
TRINO_FINAL_CREATED=0
SUCCESS=0

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws git jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ "${ASKLAKE_DAY16_SECRET_APPLY_CONFIRM:-}" == "apply-spark-trino-runtime-secrets" ]] || \
  fail "set ASKLAKE_DAY16_SECRET_APPLY_CONFIRM=apply-spark-trino-runtime-secrets"
[[ -f "$INPUT" && -s "$SPARK_MANIFEST" && -s "$TRINO_MANIFEST" ]] || fail "runtime Secret input or manifest is missing"

temporary_directory="$(mktemp -d)"
cleanup() {
  local status=$?
  trap - EXIT
  kubectl delete externalsecret "$SPARK_STAGE" "$TRINO_STAGE" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  kubectl delete secret "$SPARK_STAGE" "$TRINO_STAGE" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  if [[ "$SUCCESS" -ne 1 ]]; then
    if [[ "$TRINO_FINAL_CREATED" -eq 1 ]]; then
      kubectl delete externalsecret asklake-trino-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
      kubectl delete secret asklake-trino-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
    fi
    if [[ "$SPARK_FINAL_CREATED" -eq 1 ]]; then
      kubectl delete externalsecret asklake-spark-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
      kubectl delete secret asklake-spark-runtime -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || true
    fi
    if [[ "$TRINO_SOURCE_CREATED" -eq 1 ]]; then
      aws secretsmanager delete-secret --region "$REGION" --secret-id asklake/dev/trino/runtime \
        --force-delete-without-recovery >/dev/null 2>&1 || true
    fi
    if [[ "$SPARK_SOURCE_CREATED" -eq 1 ]]; then
      aws secretsmanager delete-secret --region "$REGION" --secret-id asklake/dev/spark/runtime \
        --force-delete-without-recovery >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$temporary_directory"
  exit "$status"
}
trap cleanup EXIT

verify_asklake_eks_context
git -C "$ROOT_DIR" check-ignore -q -- "$INPUT" || fail "private input must be ignored by Git"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$INPUT" >/dev/null 2>&1; then
  fail "private input must not be tracked by Git"
fi
node "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-input.mjs" "$INPUT" >/dev/null

for manifest in "$SPARK_MANIFEST" "$TRINO_MANIFEST"; do
  kubectl apply --dry-run=server -f "$manifest" >/dev/null
done

if aws secretsmanager describe-secret --region "$REGION" --secret-id asklake/dev/spark/runtime >/dev/null 2>&1 \
  || aws secretsmanager describe-secret --region "$REGION" --secret-id asklake/dev/trino/runtime >/dev/null 2>&1 \
  || kubectl get externalsecret asklake-spark-runtime -n "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl get externalsecret asklake-trino-runtime -n "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl get secret asklake-spark-runtime -n "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl get secret asklake-trino-runtime -n "$NAMESPACE" >/dev/null 2>&1; then
  fail "Spark/Trino runtime source or target already exists; use the verifier instead of overwriting it"
fi

ASKLAKE_EKS_CLUSTER_NAME="$ASKLAKE_EKS_CLUSTER_NAME" \
  bash "$ROOT_DIR/scripts/capture-eks-day16-a-baseline.sh" --expect-phase0 >/dev/null

jq -c '.sources.spark' "$INPUT" >"$temporary_directory/spark.json"
jq -c '.sources.trino' "$INPUT" >"$temporary_directory/trino.json"
chmod 600 "$temporary_directory/spark.json" "$temporary_directory/trino.json"

aws secretsmanager create-secret --region "$REGION" \
  --name asklake/dev/spark/runtime \
  --description "AskLake dev Spark runtime input managed through External Secrets Operator" \
  --secret-string "file://$temporary_directory/spark.json" >/dev/null
SPARK_SOURCE_CREATED=1
aws secretsmanager create-secret --region "$REGION" \
  --name asklake/dev/trino/runtime \
  --description "AskLake dev Trino runtime input managed through External Secrets Operator" \
  --secret-string "file://$temporary_directory/trino.json" >/dev/null
TRINO_SOURCE_CREATED=1

stage_manifest() {
  local manifest="$1" stage="$2"
  kubectl create --dry-run=client -f "$manifest" -o json | jq \
    --arg stage "$stage" '.metadata.name=$stage | .spec.target.name=$stage' | kubectl apply -f - >/dev/null
  kubectl wait --for=condition=Ready "externalsecret/$stage" -n "$NAMESPACE" --timeout=3m >/dev/null
}
stage_manifest "$SPARK_MANIFEST" "$SPARK_STAGE"
stage_manifest "$TRINO_MANIFEST" "$TRINO_STAGE"

spark_expected="$(jq -S -c '.sources.spark | with_entries(.value |= @base64)' "$INPUT")"
spark_actual="$(kubectl get secret "$SPARK_STAGE" -n "$NAMESPACE" -o json | jq -S -c '.data')"
[[ "$(asklake_sha256 <<<"$spark_expected")" == "$(asklake_sha256 <<<"$spark_actual")" ]] || fail "staged Spark target hash mismatch"

trino_expected="$(jq -S -c '.sources.trino | with_entries(
  if .key == "trino-keystore.jks" or .key == "trino-password.db" then . else .value |= @base64 end
)' "$INPUT")"
trino_actual="$(kubectl get secret "$TRINO_STAGE" -n "$NAMESPACE" -o json | jq -S -c '.data')"
[[ "$(asklake_sha256 <<<"$trino_expected")" == "$(asklake_sha256 <<<"$trino_actual")" ]] || fail "staged Trino target hash mismatch"
unset spark_expected spark_actual trino_expected trino_actual

kubectl delete externalsecret "$SPARK_STAGE" "$TRINO_STAGE" -n "$NAMESPACE" --wait=true >/dev/null
kubectl delete secret "$SPARK_STAGE" "$TRINO_STAGE" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null

kubectl apply -f "$SPARK_MANIFEST" >/dev/null
SPARK_FINAL_CREATED=1
kubectl apply -f "$TRINO_MANIFEST" >/dev/null
TRINO_FINAL_CREATED=1
kubectl wait --for=condition=Ready externalsecret/asklake-spark-runtime \
  externalsecret/asklake-trino-runtime -n "$NAMESPACE" --timeout=3m >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-day16-runtime-secret-delivery.sh" >/dev/null
SUCCESS=1
echo "EKS Day 16 Spark/Trino runtime Secret delivery applied and verified."
