#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-runtime-profile.sh"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
EXTERNAL_SECRET_NAME="asklake-backend-runtime"
EXPECTED_SOURCE="asklake/dev/backend/runtime"
BACKEND_SCOPE="${ASKLAKE_BACKEND_RUNTIME_SCOPE:-bounded}"
EXPECTED_KEYS=""

for command in aws jq kubectl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing required command: $command" >&2
    exit 1
  fi
done
EXPECTED_KEYS="$(asklake_backend_runtime_profile "$ROOT_DIR" "$BACKEND_SCOPE")"
[[ -n "$EXPECTED_KEYS" ]] || { echo "Backend runtime profile is invalid: $BACKEND_SCOPE" >&2; exit 1; }

verify_asklake_eks_context

external_secret_json="$(kubectl get externalsecret "$EXTERNAL_SECRET_NAME" -n "$NAMESPACE" -o json)"
target_secret_json="$(kubectl get secret "$EXTERNAL_SECRET_NAME" -n "$NAMESPACE" -o json)"

jq -e \
  --arg namespace "$NAMESPACE" \
  --arg name "$EXTERNAL_SECRET_NAME" \
  --arg source "$EXPECTED_SOURCE" \
  --argjson keys "$EXPECTED_KEYS" '
    .apiVersion == "external-secrets.io/v1"
    and .metadata.namespace == $namespace
    and .metadata.name == $name
    and .spec.secretStoreRef == {kind: "SecretStore", name: "asklake-secrets-manager"}
    and .spec.target.name == $name
    and .spec.target.creationPolicy == "Owner"
    and .spec.target.deletionPolicy == "Retain"
    and ([.spec.data[] | {
      secretKey,
      source: .remoteRef.key,
      property: .remoteRef.property
    }] | sort_by(.secretKey)) == ($keys | map({secretKey: ., source: $source, property: .}) | sort_by(.secretKey))
    and ([.status.conditions[]? | select(.type == "Ready")][0].status == "True")
  ' <<<"$external_secret_json" >/dev/null

jq -e \
  --arg name "$EXTERNAL_SECRET_NAME" \
  --argjson keys "$EXPECTED_KEYS" '
    .type == "Opaque"
    and (.data | keys | sort) == $keys
    and ((.metadata.ownerReferences // []) | any(
      .apiVersion == "external-secrets.io/v1"
      and .kind == "ExternalSecret"
      and .name == $name
      and .controller == true
    ))
  ' <<<"$target_secret_json" >/dev/null

source_json="$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "$EXPECTED_SOURCE" \
  --query SecretString \
  --output text)"

jq -e --argjson keys "$EXPECTED_KEYS" '
  (keys | sort) == $keys
  and all(.[]; type == "string" and length > 0)
' <<<"$source_json" >/dev/null

source_hash="$(jq -S -c . <<<"$source_json" | asklake_sha256)"
target_hash="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$target_secret_json" | asklake_sha256)"
unset source_json target_secret_json

if [[ "$source_hash" != "$target_hash" ]]; then
  echo "Backend runtime source and target hashes do not match" >&2
  exit 1
fi
unset source_hash target_hash

deployment_json="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
jq -e \
  --arg secret "$EXTERNAL_SECRET_NAME" '
    (.spec.replicas // 0) == 2
    and (.status.readyReplicas // 0) == 2
    and (.status.updatedReplicas // 0) == 2
    and (.status.unavailableReplicas // 0) == 0
    and any(.spec.template.spec.containers[]?;
      any(.envFrom[]?; .secretRef.name == $secret)
    )
  ' <<<"$deployment_json" >/dev/null

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null

echo "EKS Day 15 Backend ExternalSecret runtime verification passed"
