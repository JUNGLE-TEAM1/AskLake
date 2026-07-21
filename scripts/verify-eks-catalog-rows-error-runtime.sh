#!/usr/bin/env bash

set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/verify-eks-context.sh"

NAMESPACE="${ASKLAKE_EKS_NAMESPACE:-asklake-dev}"
TEMP_DIR="$(mktemp -d)"
COOKIE_JAR="$TEMP_DIR/cookies.txt"
LOGIN_HEADERS="$TEMP_DIR/login-headers.txt"
LOGIN_BODY="$TEMP_DIR/login.json"
DATASETS_BODY="$TEMP_DIR/datasets.json"
ROWS_BODY="$TEMP_DIR/rows.json"
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

for command in curl jq kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

verify_asklake_eks_context
bash "$ROOT_DIR/scripts/verify-eks-day15-alb-runtime.sh" --steady >/dev/null

configmap="$(kubectl get configmap asklake-runtime -n "$NAMESPACE" -o json)"
target_secret="$(kubectl get secret asklake-backend-runtime -n "$NAMESPACE" -o json)"
jq -e '.data.APP_ENV == "production" and .data.TRINO_ENABLED == "false"' <<<"$configmap" >/dev/null || \
  fail "the runtime must be production with Trino disabled for the expected error contract"
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
  | curl -sS -D "$LOGIN_HEADERS" -o "$LOGIN_BODY" -c "$COOKIE_JAR" -w '%{http_code}' \
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

dataset_id="$(jq -r '
  [.datasets[]
    | select((.storageFormat // "" | ascii_downcase) == "iceberg")
    | select(.queryEngineStatus == "available")
    | select(.queryEngineTable != null)
  ][0].id // ""
' "$DATASETS_BODY")"
[[ -n "$dataset_id" ]] || fail "no queryable Iceberg Dataset is available for the runtime regression"
encoded_dataset_id="$(jq -rn --arg value "$dataset_id" '$value | @uri')"

rows_status="$(curl -sS -o "$ROWS_BODY" -w '%{http_code}' \
  --connect-timeout 5 --max-time 30 \
  -H "Cookie: asklake_session=$SESSION_TOKEN" \
  "http://$BACKEND_HOST/api/catalog/datasets/$encoded_dataset_id/rows?limit=1&offset=0")"
[[ "$rows_status" == "502" ]] || fail "Catalog Iceberg rows did not return the expected HTTP 502 contract"
jq -e --arg dataset_id "$dataset_id" '
  . == {
    error: {
      code: "SQL_STORAGE_ERROR",
      message: "Catalog Iceberg dataset rows could not be read",
      details: {
        datasetId: $dataset_id,
        reason: "BACKEND_TIMEOUT"
      }
    }
  }
' "$ROWS_BODY" >/dev/null || fail "Catalog Iceberg rows error envelope drifted or exposed extra details"

if grep -Eiq 'NameError|Traceback|https?://|authorization|bearer|password|token|SELECT[[:space:]]' "$ROWS_BODY"; then
  fail "Catalog Iceberg rows error response exposed an internal marker"
fi

echo "catalog_rows_runtime_dataset=eligible_iceberg_selected"
echo "catalog_rows_runtime_http_status=502"
echo "catalog_rows_runtime_error_code=SQL_STORAGE_ERROR"
echo "catalog_rows_runtime_error_reason=BACKEND_TIMEOUT"
echo "catalog_rows_runtime_private_markers=absent"
