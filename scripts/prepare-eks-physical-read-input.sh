#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

OUTPUT_PATH="${1:-${ASKLAKE_PHYSICAL_READ_INPUT:-}}"
NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}"
TEMP_DIR="$(mktemp -d)"
LOGIN_HEADERS="$TEMP_DIR/login-headers.txt"
LOGIN_BODY="$TEMP_DIR/login.json"
DATASETS_BODY="$TEMP_DIR/datasets.json"
SESSION_TOKEN=""
BACKEND_HOST=""

cleanup() {
  if [[ -n "$SESSION_TOKEN" && -n "$BACKEND_HOST" ]]; then
    curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
      -X POST -H "Cookie: asklake_session=$SESSION_TOKEN" \
      "http://$BACKEND_HOST/api/auth/logout" || true
  fi
  unset SESSION_TOKEN admin_email admin_password
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

for command in aws curl git jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -n "$OUTPUT_PATH" ]] || fail "ASKLAKE_PHYSICAL_READ_INPUT output path is required"

output_dir="$(cd "$(dirname "$OUTPUT_PATH")" && pwd)"
OUTPUT_PATH="$output_dir/$(basename "$OUTPUT_PATH")"
[[ "$OUTPUT_PATH" == "$ROOT_DIR"/infra/eks/delivery/*.physical-read-input.json ]] || \
  fail "physical read input must use the private infra/eks/delivery path"
if git -C "$ROOT_DIR" ls-files --error-unmatch -- "$OUTPUT_PATH" >/dev/null 2>&1; then
  fail "physical read input must not be tracked by Git"
fi
git -C "$ROOT_DIR" check-ignore -q -- "$OUTPUT_PATH" || fail "physical read input must be covered by .gitignore"

verify_asklake_eks_context
bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null

configmap="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json)"
target_secret="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
admin_email="$(jq -r '.data.BOOTSTRAP_ADMIN_EMAIL // ""' <<<"$configmap")"
admin_password="$(jq -r '.data.BOOTSTRAP_ADMIN_PASSWORD // "" | @base64d' <<<"$target_secret")"
[[ -n "$admin_email" && -n "$admin_password" ]] || fail "bootstrap administrator credentials are unavailable"
unset configmap target_secret

ingresses="$(kubectl get ingress asklake-backend asklake-frontend -n "$NAMESPACE" -o json)"
BACKEND_HOST="$(jq -r '[.items[] | select(.metadata.name == "asklake-backend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
frontend_host="$(jq -r '[.items[] | select(.metadata.name == "asklake-frontend") | .status.loadBalancer.ingress[0].hostname][0] // ""' <<<"$ingresses")"
[[ -n "$BACKEND_HOST" && "$BACKEND_HOST" == "$frontend_host" ]] || fail "Frontend and Backend do not share one ready ALB"
unset ingresses frontend_host

login_status="$(jq -n --arg email "$admin_email" --arg password "$admin_password" '{email:$email,password:$password}' \
  | curl -sS -D "$LOGIN_HEADERS" -o "$LOGIN_BODY" -w '%{http_code}' \
      --connect-timeout 5 --max-time 20 \
      -H 'Content-Type: application/json' --data-binary @- \
      "http://$BACKEND_HOST/api/auth/login")"
unset admin_email admin_password
[[ "$login_status" == "200" ]] || fail "Backend administrator login failed"
jq -e '.user.role == "admin"' "$LOGIN_BODY" >/dev/null || fail "Backend login did not return an administrator"
SESSION_TOKEN="$(awk '
  tolower($0) ~ /^set-cookie:[[:space:]]*asklake_session=/ {
    line = $0
    sub(/^[^=]*=/, "", line)
    sub(/;.*/, "", line)
    gsub(/\r/, "", line)
    print line
  }
' "$LOGIN_HEADERS" | tail -n 1)"
[[ -n "$SESSION_TOKEN" ]] || fail "Backend login did not issue a session cookie"

datasets_status="$(curl -sS -o "$DATASETS_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 30 \
  -H "Cookie: asklake_session=$SESSION_TOKEN" \
  "http://$BACKEND_HOST/api/catalog/datasets")"
[[ "$datasets_status" == "200" ]] || fail "Catalog Dataset list request failed"

selected_dataset_id=""
selected_root=""
selected_object=""
while IFS=$'\t' read -r dataset_id storage_location; do
  [[ -n "$dataset_id" && -n "$storage_location" ]] || continue
  normalized_location="${storage_location/s3:\/\//s3a://}"
  [[ "$normalized_location" =~ ^s3a://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[^[:space:]?#\\]+$ ]] || continue
  normalized_location="${normalized_location%/}"
  bucket_and_prefix="${normalized_location#s3a://}"
  bucket="${bucket_and_prefix%%/*}"
  prefix="${bucket_and_prefix#*/}"
  objects="$(aws s3api list-objects-v2 \
    --region "$REGION" --bucket "$bucket" --prefix "$prefix/" --output json)" || continue
  object_key="$(jq -r '[.Contents[]? | select(.Size > 0 and (.Key | endswith(".parquet")))] | sort_by(.Key) | .[0].Key // ""' <<<"$objects")"
  [[ -n "$object_key" ]] || continue
  aws s3api head-object --region "$REGION" --bucket "$bucket" --key "$object_key" >/dev/null || continue
  selected_dataset_id="$dataset_id"
  selected_root="$normalized_location"
  selected_object="s3a://$bucket/$object_key"
  break
done < <(jq -r '
  .datasets[]
  | select((.storageFormat // "" | ascii_downcase) == "iceberg")
  | select(.queryEngineStatus == "available")
  | select(.queryEngineTable != null)
  | select((.storageLocation // "") != "")
  | [.id, .storageLocation]
  | @tsv
' "$DATASETS_BODY")

[[ -n "$selected_dataset_id" && -n "$selected_root" && -n "$selected_object" ]] || \
  fail "no Catalog Iceberg Dataset with a readable Parquet object was found"
[[ "$selected_object" == "$selected_root/"* ]] || fail "selected object is outside the Catalog materialization root"

private_temp="$(mktemp "$output_dir/.physical-read-input.XXXXXX")"
chmod 600 "$private_temp"
jq -n \
  --arg datasetId "$selected_dataset_id" \
  --arg materializationRoot "$selected_root" \
  --arg objectUri "$selected_object" \
  '{datasetId:$datasetId,materializationRoot:$materializationRoot,objectUri:$objectUri}' \
  >"$private_temp"
mv "$private_temp" "$OUTPUT_PATH"
chmod 600 "$OUTPUT_PATH"

echo "physical_read_input_catalog_dataset=selected"
echo "physical_read_input_parquet_object=verified_non_empty"
echo "physical_read_input_root_boundary=verified"
echo "physical_read_input_git_tracking=ignored"
