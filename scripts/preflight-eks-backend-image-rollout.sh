#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"
source "$ROOT_DIR/scripts/lib/eks-backend-runtime-profile.sh"

RECEIPT_PATH="${1:-${ASKLAKE_IMAGE_RECEIPT:-}}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
FIX_COMMIT="${ASKLAKE_BACKEND_FIX_COMMIT:-f556e95ebfc72897983fb8079e335c8296d956e1}"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
TEMP_DIR="$(mktemp -d)"
CURRENT_VALUES="$TEMP_DIR/current-values.json"
CANDIDATE_VALUES="$TEMP_DIR/candidate-values.json"
RENDERED_FILE="$TEMP_DIR/rendered.yaml"
trap 'rm -rf "$TEMP_DIR"' EXIT
trap 'echo "Backend image preflight failed at line $LINENO" >&2' ERR

fail() {
  echo "$1" >&2
  exit 1
}

verify_backend_secret_runtime() {
  local external_secret_json target_secret_json source_json target_keys expected_keys source_hash target_hash
  expected_keys="$(asklake_backend_runtime_profile "$ROOT_DIR" "${ASKLAKE_BACKEND_RUNTIME_SCOPE:-bounded}")" || \
    fail "Backend runtime profile is invalid"
  external_secret_json="$(kubectl get externalsecret asklake-backend-runtime -n "$NAMESPACE" -o json)"
  target_secret_json="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
  target_keys="$(jq -c '.data | keys | sort' <<<"$target_secret_json")"

  jq -e --argjson keys "$target_keys" '
    any(.status.conditions[]?; .type == "Ready" and .status == "True")
    and .spec.secretStoreRef == {kind: "SecretStore", name: "asklake-secrets-manager"}
    and .spec.target.name == "asklake-backend-runtime"
    and .spec.target.creationPolicy == "Owner"
    and ([.spec.data[].secretKey] | sort) == $keys
    and all(.spec.data[];
      .remoteRef.key == "asklake/dev/backend/runtime"
      and .remoteRef.property == .secretKey
    )
  ' <<<"$external_secret_json" >/dev/null || fail "Backend ExternalSecret mapping is invalid"

  jq -e --argjson keys "$target_keys" '
    .type == "Opaque"
    and (.data | keys | sort) == $keys
    and any(.metadata.ownerReferences[]?;
      .apiVersion == "external-secrets.io/v1"
      and .kind == "ExternalSecret"
      and .name == "asklake-backend-runtime"
      and .controller == true
    )
  ' <<<"$target_secret_json" >/dev/null || fail "Backend runtime Secret owner or key contract is invalid"

  jq -e --argjson keys "$expected_keys" '
    . == $keys
  ' <<<"$target_keys" >/dev/null || fail "Backend runtime Secret contains an unapproved key set"

  source_json="$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id asklake/dev/backend/runtime \
    --query SecretString \
    --output text)"
  jq -e --argjson keys "$target_keys" 'keys | sort == $keys' <<<"$source_json" >/dev/null || \
    fail "Backend runtime source key set does not match the target"
  source_hash="$(jq -S -c . <<<"$source_json" | asklake_sha256)"
  target_hash="$(jq -S -c '.data | with_entries(.value |= @base64d)' <<<"$target_secret_json" | asklake_sha256)"
  [[ "$source_hash" == "$target_hash" ]] || fail "Backend runtime source and target hashes do not match"
  unset external_secret_json target_secret_json source_json target_keys expected_keys source_hash target_hash
}

for command in aws git helm jq kubectl node; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ -n "$RECEIPT_PATH" && -f "$RECEIPT_PATH" ]] || fail "a private ASKLAKE_IMAGE_RECEIPT file is required"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$RECEIPT_PATH" >/dev/null 2>&1; then
  fail "the rollout image receipt must not be tracked by Git"
fi
git -C "$ROOT_DIR" check-ignore -q -- "$RECEIPT_PATH" || fail "the rollout image receipt must be covered by .gitignore"

verify_asklake_eks_context
node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT_PATH" >/dev/null

receipt_commit="$(jq -r '.gitRevision' "$RECEIPT_PATH")"
new_backend_image="$(jq -r '.images.backend' "$RECEIPT_PATH")"
git -C "$ROOT_DIR" merge-base --is-ancestor "$FIX_COMMIT" "$receipt_commit" || \
  fail "the Backend receipt revision does not contain the Catalog rows fix"
git -C "$ROOT_DIR" merge-base --is-ancestor "$receipt_commit" HEAD || \
  fail "the Backend receipt revision is not contained in the current branch"

deployment_before="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
current_backend_image="$(jq -r '.spec.template.spec.containers[] | select(.name == "fastapi") | .image' <<<"$deployment_before")"
current_frontend_image="$(kubectl get deployment frontend -n "$NAMESPACE" -o json | jq -r '.spec.template.spec.containers[] | select(.name == "frontend") | .image')"
[[ "$new_backend_image" != "$current_backend_image" ]] || fail "the candidate Backend image is already deployed"

jq -e '
  (.spec.replicas // 0) == 2
  and (.status.readyReplicas // 0) == 2
  and (.status.updatedReplicas // 0) == 2
  and (.status.availableReplicas // 0) == 2
  and (.status.unavailableReplicas // 0) == 0
' <<<"$deployment_before" >/dev/null || fail "the current Backend Deployment is not steady"

bash "$ROOT_DIR/scripts/verify-eks-backend-image-provenance.sh" \
  "$RECEIPT_PATH" "$new_backend_image" "$receipt_commit" >/dev/null

repository_uri="${new_backend_image%@*}"
repository_name="${repository_uri#*/}"
digest="${new_backend_image##*@}"
manifest_json="$(aws ecr batch-get-image \
  --region "$REGION" \
  --repository-name "$repository_name" \
  --image-ids "imageDigest=$digest" \
  --accepted-media-types \
    application/vnd.oci.image.index.v1+json \
    application/vnd.docker.distribution.manifest.list.v2+json \
  --query 'images[0].imageManifest' \
  --output text)"
jq -e '
  ([.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")] | length) >= 1
  and ([.manifests[]? | select(.platform.architecture != "amd64" and .platform.architecture != "unknown")] | length) == 0
' <<<"$manifest_json" >/dev/null || fail "the candidate Backend image is not an AMD64-only runtime index"
unset manifest_json

helm get values asklake-web -n "$NAMESPACE" -o json >"$CURRENT_VALUES"
jq --arg image "$new_backend_image" '.backend.image = $image' "$CURRENT_VALUES" >"$CANDIDATE_VALUES"
jq -e --slurp '
  (.[0] | del(.backend.image)) == (.[1] | del(.backend.image))
  and .[0].backend.image != .[1].backend.image
' "$CURRENT_VALUES" "$CANDIDATE_VALUES" >/dev/null || fail "candidate values changed more than backend.image"

helm lint "$CHART_DIR" -f "$CANDIDATE_VALUES" >/dev/null
helm template asklake-web "$CHART_DIR" -f "$CANDIDATE_VALUES" >"$RENDERED_FILE"

rendered_backend_image="$(awk '
  $1 == "-" && $2 == "name:" && $3 == "fastapi" { in_container = 1; next }
  in_container && $1 == "image:" { gsub(/"/, "", $2); print $2; exit }
' "$RENDERED_FILE")"
rendered_frontend_image="$(awk '
  $1 == "-" && $2 == "name:" && $3 == "frontend" { in_container = 1; next }
  in_container && $1 == "image:" { gsub(/"/, "", $2); print $2; exit }
' "$RENDERED_FILE")"
[[ "$rendered_backend_image" == "$new_backend_image" ]] || fail "rendered Backend image does not match the candidate receipt"
[[ "$rendered_frontend_image" == "$current_frontend_image" ]] || fail "Backend-only preflight changed the Frontend image"

jq -e --arg namespace "$NAMESPACE" '
  .enabled == true
  and .namespace == $namespace
  and .backend.replicaCount == 2
  and .frontend.replicaCount == 2
  and .readiness.foundationReady == true
  and .readiness.generalNodePoolReady == true
  and .readiness.imageReceiptVerified == true
  and .readiness.runtimeConfigReady == true
  and .readiness.runtimeSecretReady == true
  and .readiness.backendRuntimeBoundaryReady == true
' "$CANDIDATE_VALUES" >/dev/null || fail "candidate values do not preserve the approved web readiness contract"

release_revision_before="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "asklake-web") | .revision')"
deployment_generation_before="$(jq -r '.metadata.generation' <<<"$deployment_before")"
pod_uids_before="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"

helm upgrade --install asklake-web "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace=false \
  -f "$CANDIDATE_VALUES" --dry-run=server >/dev/null

release_revision_after="$(helm list -n "$NAMESPACE" -o json | jq -r '.[] | select(.name == "asklake-web") | .revision')"
deployment_after="$(kubectl get deployment fastapi -n "$NAMESPACE" -o json)"
deployment_generation_after="$(jq -r '.metadata.generation' <<<"$deployment_after")"
deployed_image_after="$(jq -r '.spec.template.spec.containers[] | select(.name == "fastapi") | .image' <<<"$deployment_after")"
pod_uids_after="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/component=backend -o json | jq -r '.items[].metadata.uid' | LC_ALL=C sort)"
[[ "$release_revision_after" == "$release_revision_before" ]] || fail "server dry-run changed the Helm release revision"
[[ "$deployment_generation_after" == "$deployment_generation_before" ]] || fail "server dry-run changed the Backend Deployment generation"
[[ "$deployed_image_after" == "$current_backend_image" ]] || fail "server dry-run changed the deployed Backend image"
[[ "$pod_uids_after" == "$pod_uids_before" ]] || fail "server dry-run replaced Backend Pods"

bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null
verify_backend_secret_runtime
bash "$ROOT_DIR/scripts/verify-eks-continuous-process-boundary.sh" >/dev/null
bash "$ROOT_DIR/scripts/verify-eks-external-ec2-instance.sh" >/dev/null

echo "backend_candidate_receipt=verified_fix_ancestor"
echo "backend_candidate_platform=linux_amd64"
echo "backend_candidate_values_change=backend_image_only"
echo "backend_candidate_server_dry_run=passed"
echo "backend_candidate_cluster_mutation=zero"
echo "backend_candidate_pre_rollout_health=passed"
