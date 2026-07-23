#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECEIPT_PATH="${1:-${ASKLAKE_IMAGE_RECEIPT:-}}"
DEPLOYED_IMAGE="${2:-}"
EXPECTED_COMMIT="${3:-${ASKLAKE_EXPECTED_BACKEND_COMMIT:-}}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"

for command in aws git jq node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
[[ -n "$RECEIPT_PATH" && -f "$RECEIPT_PATH" ]] || {
  echo "a private ASKLAKE_IMAGE_RECEIPT file is required" >&2
  exit 1
}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ASKLAKE_EXPECTED_BACKEND_COMMIT must be a full 40-character Git SHA" >&2
  exit 1
}
[[ "$DEPLOYED_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || {
  echo "deployed Backend image must use an immutable digest" >&2
  exit 1
}

node "$ROOT_DIR/scripts/verify-eks-image-receipt.mjs" "$RECEIPT_PATH" >/dev/null
receipt_commit="$(jq -r '.gitRevision' "$RECEIPT_PATH")"
receipt_image="$(jq -r '.images.backend' "$RECEIPT_PATH")"
[[ "$receipt_commit" == "$EXPECTED_COMMIT" ]] || {
  echo "Backend receipt revision does not match the reviewed commit" >&2
  exit 1
}
[[ "$receipt_image" == "$DEPLOYED_IMAGE" ]] || {
  echo "deployed Backend image does not match the verified receipt" >&2
  exit 1
}
git -C "$ROOT_DIR" cat-file -e "${EXPECTED_COMMIT}^{commit}" 2>/dev/null || {
  echo "reviewed Backend commit is not available in the repository" >&2
  exit 1
}
git -C "$ROOT_DIR" merge-base --is-ancestor "$EXPECTED_COMMIT" HEAD || {
  echo "reviewed Backend commit is not contained in the current branch" >&2
  exit 1
}

repository_uri="${DEPLOYED_IMAGE%@*}"
digest="${DEPLOYED_IMAGE##*@}"
repository_name="${repository_uri#*/}"
image_count="$(aws ecr describe-images \
  --region "$REGION" \
  --repository-name "$repository_name" \
  --image-ids "imageDigest=$digest" \
  --query 'length(imageDetails)' \
  --output text)"
[[ "$image_count" == "1" ]] || {
  echo "the receipt Backend digest does not exist exactly once in ECR" >&2
  exit 1
}
mutability="$(aws ecr describe-repositories \
  --region "$REGION" \
  --repository-names "$repository_name" \
  --query 'repositories[0].imageTagMutability' \
  --output text)"
[[ "$mutability" == "IMMUTABLE" || "$mutability" == "IMMUTABLE_WITH_EXCLUSION" ]] || {
  echo "Backend ECR repository is not immutable" >&2
  exit 1
}

echo "backend_receipt_revision=verified_full_sha"
echo "backend_receipt_image=verified_immutable_digest"
