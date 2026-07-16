#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-secret-rollback.sh"

MODE="${1:---verify-existing}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
NAME="asklake-backend-runtime"
SOURCE_NAME="asklake/dev/backend/runtime"
MANIFEST="$ROOT_DIR/infra/eks/secrets/backend-runtime-external-secret.yaml"
RUN_TOKEN="$(date -u +%s)-$$-${RANDOM}"
STAGE_NAME="${NAME}-stage-${RUN_TOKEN}"
FINAL_STARTED=0
SOURCE_JSON=""

usage() {
  echo "usage: $0 --verify-existing|--handover" >&2
}

if [[ "$MODE" != "--verify-existing" && "$MODE" != "--handover" ]]; then
  usage
  exit 2
fi
for command in aws jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ -s "$MANIFEST" ]] || { echo "Backend ExternalSecret manifest is missing" >&2; exit 1; }
verify_asklake_eks_context

cleanup_stage() {
  asklake_cleanup_backend_secret_stage "$STAGE_NAME" "$NAMESPACE"
}

restore_manual_target() {
  asklake_restore_backend_manual_secret "$ROOT_DIR" "$NAME" "$NAMESPACE" "$SOURCE_JSON"
}

on_exit() {
  local status=$?
  local cleanup_failed=0 rollback_failed=0
  trap - EXIT
  cleanup_stage || cleanup_failed=1
  if [[ "$status" -ne 0 && "$FINAL_STARTED" -eq 1 ]]; then
    echo "ExternalSecret handover failed; restoring the validated manual target" >&2
    if ! restore_manual_target; then
      rollback_failed=1
      echo "ExternalSecret handover rollback failed; manual recovery is required" >&2
    fi
  fi
  SOURCE_JSON=""
  if [[ "$cleanup_failed" -ne 0 ]]; then
    echo "ExternalSecret stage cleanup failed" >&2
  fi
  if [[ "$status" -eq 0 && "$cleanup_failed" -ne 0 ]]; then
    status=1
  fi
  if [[ "$rollback_failed" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap on_exit EXIT

if kubectl get externalsecret "$NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
  if kubectl get externalsecret "$NAME" -n "$NAMESPACE" -o json | jq -e '
      any(.status.conditions[]?; .type == "Ready" and .status == "True")
    ' >/dev/null \
    && kubectl get secret "$NAME" -n "$NAMESPACE" -o json | jq -e --arg name "$NAME" '
      any(.metadata.ownerReferences[]?; .apiVersion == "external-secrets.io/v1" and .kind == "ExternalSecret" and .name == $name and .controller == true)
    ' >/dev/null; then
    bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null
    echo "backend_runtime_secret_state=external_secret_ready"
    exit 0
  fi
  echo "Backend ExternalSecret exists but is not a verified Ready owner" >&2
  exit 1
fi

target_secret_json="$(kubectl get secret "$NAME" -n "$NAMESPACE" -o json)"
jq -e '
  .type == "Opaque"
  and (.data | keys | sort) == ["BOOTSTRAP_ADMIN_PASSWORD", "DATABASE_URL"]
  and ((.metadata.ownerReferences // []) | length == 0)
' <<<"$target_secret_json" >/dev/null || {
  echo "manual Backend runtime target does not match the handover contract" >&2
  exit 1
}

SOURCE_JSON="$(aws secretsmanager get-secret-value \
  --region "$REGION" --secret-id "$SOURCE_NAME" --query SecretString --output text)"
jq -e '
  (keys | sort) == ["BOOTSTRAP_ADMIN_PASSWORD", "DATABASE_URL"]
  and (.DATABASE_URL | type == "string" and length > 0)
  and (.BOOTSTRAP_ADMIN_PASSWORD | type == "string" and length > 0)
' <<<"$SOURCE_JSON" >/dev/null
source_hash="$(jq -S -c '{BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$SOURCE_JSON" | asklake_sha256)"
target_hash="$(jq -S -c '.data | with_entries(.value |= @base64d) | {BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$target_secret_json" | asklake_sha256)"
unset target_secret_json
[[ "$source_hash" == "$target_hash" ]] || {
  echo "manual Backend target and Secrets Manager source hashes differ" >&2
  exit 1
}
unset source_hash target_hash

if [[ "$MODE" == "--verify-existing" ]]; then
  echo "backend_runtime_secret_state=manual_source_verified"
  exit 0
fi
[[ "${ASKLAKE_BACKEND_SECRET_HANDOVER_CONFIRM:-}" == "handover-validated-backend-runtime" ]] || {
  echo "set ASKLAKE_BACKEND_SECRET_HANDOVER_CONFIRM=handover-validated-backend-runtime" >&2
  exit 1
}

kubectl create --dry-run=client -f "$MANIFEST" -o json \
  | jq --arg namespace "$NAMESPACE" --arg name "$STAGE_NAME" '
      .metadata.namespace=$namespace | .metadata.name=$name | .spec.target.name=$name
    ' \
  | kubectl apply -f - >/dev/null
kubectl wait --for=condition=Ready "externalsecret/$STAGE_NAME" -n "$NAMESPACE" --timeout=3m >/dev/null
stage_secret_json="$(kubectl get secret "$STAGE_NAME" -n "$NAMESPACE" -o json)"
stage_hash="$(jq -S -c '.data | with_entries(.value |= @base64d) | {BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$stage_secret_json" | asklake_sha256)"
source_hash="$(jq -S -c '{BOOTSTRAP_ADMIN_PASSWORD,DATABASE_URL}' <<<"$SOURCE_JSON" | asklake_sha256)"
unset stage_secret_json
[[ "$stage_hash" == "$source_hash" ]] || {
  echo "staged ESO target and source hashes differ" >&2
  exit 1
}
unset stage_hash source_hash
cleanup_stage

FINAL_STARTED=1
kubectl create --dry-run=client -f "$MANIFEST" -o json \
  | jq --arg namespace "$NAMESPACE" '.metadata.namespace=$namespace' \
  | kubectl apply -f - >/dev/null
kubectl delete secret "$NAME" -n "$NAMESPACE" --wait=true >/dev/null
kubectl annotate externalsecret "$NAME" -n "$NAMESPACE" \
  "force-sync=$(date +%s)" --overwrite >/dev/null
kubectl wait --for=condition=Ready "externalsecret/$NAME" -n "$NAMESPACE" --timeout=3m >/dev/null
kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null
FINAL_STARTED=0
SOURCE_JSON=""
echo "backend_runtime_secret_handover=passed"
