#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-runtime-profile.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
NAME="asklake-backend-runtime"
SOURCE_NAME="asklake/dev/backend/runtime"
MANIFEST="$ROOT_DIR/infra/eks/secrets/backend-runtime-external-secret.yaml"
RUNTIME_CONTRACT="${ASKLAKE_DAY16_RUNTIME_CONTRACT:-$ROOT_DIR/infra/eks/secrets/dev.day16-a.runtime-secret-contract.json}"
STATE="${ASKLAKE_TERRAFORM_STATE:-$ROOT_DIR/infra/eks/terraform/terraform.tfstate}"
RUN_TOKEN="$(date -u +%s)-$$-${RANDOM}"
STAGE_NAME="${NAME}-full-service-stage-${RUN_TOKEN}"
FINAL_STARTED=0

fail() { echo "$1" >&2; exit 1; }
[[ "${ASKLAKE_BACKEND_FULL_SERVICE_CONFIRM:-}" == "promote-validated-direct-runtime" ]] || \
  fail "set ASKLAKE_BACKEND_FULL_SERVICE_CONFIRM=promote-validated-direct-runtime"
for command in aws git jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -s "$MANIFEST" && -s "$RUNTIME_CONTRACT" && -s "$STATE" ]] || fail "Backend full-service input is missing"
node "$ROOT_DIR/scripts/verify-eks-runtime-secrets.mjs" --full-service-ready "$RUNTIME_CONTRACT" >/dev/null || \
  fail "direct rollback runtime contract is not ready"
jq -e '.runtimeDecisions.aiRuntime.status=="selected" and .runtimeDecisions.aiRuntime.selected=="direct"' \
  "$RUNTIME_CONTRACT" >/dev/null || fail "this legacy promoter is restricted to explicit direct rollback contracts"
git -C "$ROOT_DIR" check-ignore -q -- "$RUNTIME_CONTRACT" || fail "private runtime contract must remain ignored"
[[ "$(stat -f '%Lp' "$RUNTIME_CONTRACT")" == "600" ]] || fail "private runtime contract must use mode 0600"
export ASKLAKE_EKS_CLUSTER_NAME="${ASKLAKE_EKS_CLUSTER_NAME:-$(jq -r '.outputs.cluster_name.value // empty' "$STATE")}"
verify_asklake_eks_context

FULL_KEYS="$(asklake_backend_runtime_profile "$ROOT_DIR" full-service "$RUNTIME_CONTRACT")"
BOUNDED_KEYS="$(asklake_backend_runtime_profile "$ROOT_DIR" bounded "$RUNTIME_CONTRACT")"
jq -e 'length==13 and index("OPENAI_API_KEY")!=null' <<<"$FULL_KEYS" >/dev/null || \
  fail "direct full-service profile must contain the exact 13-key contract"

temporary_directory="$(mktemp -d)"
current_external_secret="$temporary_directory/current-external-secret.json"
full_source="$temporary_directory/full-source.json"
bounded_source="$temporary_directory/bounded-source.json"
stage_manifest="$temporary_directory/stage.json"
final_manifest="$temporary_directory/final.json"
chmod 700 "$temporary_directory"

cleanup_stage() {
  kubectl delete externalsecret "$STAGE_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || return 1
  kubectl delete secret "$STAGE_NAME" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1 || return 1
}

wait_for_target() {
  local expected_keys="$1" expected_hash="$2" attempts=0 target
  while [[ "$attempts" -lt 90 ]]; do
    target="$(kubectl get secret "$NAME" -n "$NAMESPACE" -o json 2>/dev/null || true)"
    if [[ -n "$target" ]] \
      && jq -e --argjson keys "$expected_keys" '(.data|keys|sort)==$keys' <<<"$target" >/dev/null 2>&1 \
      && [[ "$(jq -S -c '.data|with_entries(.value|=@base64d)' <<<"$target" | asklake_sha256)" == "$expected_hash" ]]; then
      return 0
    fi
    attempts=$((attempts+1))
    sleep 2
  done
  return 1
}

wait_for_backend_runtime() {
  local scope="$1" attempts=0 consecutive=0
  while [[ "$attempts" -lt 120 ]]; do
    if ASKLAKE_BACKEND_RUNTIME_SCOPE="$scope" \
      ASKLAKE_DAY16_RUNTIME_CONTRACT="$RUNTIME_CONTRACT" \
      bash "$ROOT_DIR/scripts/verify-eks-day15-backend-secret-runtime.sh" >/dev/null 2>&1; then
      consecutive=$((consecutive+1))
      [[ "$consecutive" -ge 6 ]] && return 0
    else
      consecutive=0
    fi
    attempts=$((attempts+1))
    sleep 5
  done
  return 1
}

rollback() {
  local bounded_hash
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SOURCE_NAME" \
    --secret-string "file://$bounded_source" >/dev/null || return 1
  jq '{apiVersion,kind,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels,annotations:.metadata.annotations},spec}' \
    "$current_external_secret" | kubectl apply -f - >/dev/null || return 1
  kubectl annotate externalsecret "$NAME" -n "$NAMESPACE" "force-sync=$(date +%s)" --overwrite >/dev/null || return 1
  bounded_hash="$(jq -S -c . "$bounded_source" | asklake_sha256)"
  wait_for_target "$BOUNDED_KEYS" "$bounded_hash" || return 1
  kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null || return 1
  kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null || return 1
  wait_for_backend_runtime bounded || return 1
}

on_exit() {
  local status=$? cleanup_failed=0 rollback_failed=0
  trap - EXIT
  cleanup_stage || cleanup_failed=1
  if [[ "$status" -ne 0 && "$FINAL_STARTED" -eq 1 ]]; then
    echo "Backend full-service promotion failed; restoring bounded source, ExternalSecret and workload" >&2
    rollback || rollback_failed=1
  fi
  rm -rf "$temporary_directory"
  [[ "$cleanup_failed" -eq 0 && "$rollback_failed" -eq 0 ]] || status=1
  exit "$status"
}
trap on_exit EXIT

kubectl get externalsecret "$NAME" -n "$NAMESPACE" -o json >"$current_external_secret"
aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SOURCE_NAME" \
  --query SecretString --output text >"$full_source"
jq 'del(.OPENAI_API_KEY)' "$full_source" >"$bounded_source"

jq -e --argjson keys "$FULL_KEYS" '
  (keys|sort)==$keys
  and (.OPENAI_API_KEY|type=="string" and startswith("sk-") and length>=20)
  and all(.[]; type=="string" and length>0)
' "$full_source" >/dev/null || fail "Secrets Manager full-service source is invalid"
jq -e --argjson keys "$BOUNDED_KEYS" '(keys|sort)==$keys and all(.[]; type=="string" and length>0)' \
  "$bounded_source" >/dev/null || fail "bounded rollback source is invalid"

jq -e --argjson keys "$BOUNDED_KEYS" '
  ([.spec.data[].secretKey]|sort)==$keys
  and any(.status.conditions[]?; .type=="Ready" and .status=="True")
' "$current_external_secret" >/dev/null || fail "current Backend ExternalSecret is not the verified bounded baseline"
kubectl get secret "$NAME" -n "$NAMESPACE" -o json | jq -e --argjson keys "$BOUNDED_KEYS" \
  '(.data|keys|sort)==$keys' >/dev/null || fail "current Backend target is not the bounded baseline"

kubectl create --dry-run=client -f "$MANIFEST" -o json | jq --arg source "$SOURCE_NAME" '
  .spec.data += [{
    secretKey:"OPENAI_API_KEY",
    remoteRef:{key:$source,property:"OPENAI_API_KEY"}
  }]
' >"$final_manifest"
jq -e --argjson keys "$FULL_KEYS" '([.spec.data[].secretKey]|sort)==$keys' "$final_manifest" >/dev/null || \
  fail "Backend ExternalSecret manifest does not match the full-service profile"
jq --arg name "$STAGE_NAME" '
  .metadata.name=$name | .spec.target.name=$name
' "$final_manifest" >"$stage_manifest"
kubectl apply -f "$stage_manifest" >/dev/null
kubectl wait --for=condition=Ready "externalsecret/$STAGE_NAME" -n "$NAMESPACE" --timeout=3m >/dev/null
stage_hash="$(kubectl get secret "$STAGE_NAME" -n "$NAMESPACE" -o json \
  | jq -S -c '.data|with_entries(.value|=@base64d)' | asklake_sha256)"
source_hash="$(jq -S -c . "$full_source" | asklake_sha256)"
[[ "$stage_hash" == "$source_hash" ]] || fail "staged full-service target differs from the source"
cleanup_stage

FINAL_STARTED=1
kubectl apply -f "$final_manifest" >/dev/null
kubectl annotate externalsecret "$NAME" -n "$NAMESPACE" "force-sync=$(date +%s)" --overwrite >/dev/null
wait_for_target "$FULL_KEYS" "$source_hash" || fail "canonical Backend target did not converge to full-service"
kubectl rollout restart deployment/fastapi -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/fastapi -n "$NAMESPACE" --timeout=5m >/dev/null
wait_for_backend_runtime full-service || fail "Backend full-service runtime did not become steady"
FINAL_STARTED=0
printf 'backend_full_service_secret=promoted keys=13 rollout=ready\n'
