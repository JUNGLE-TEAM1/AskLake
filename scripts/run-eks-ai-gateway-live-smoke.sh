#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
INPUT="${2:-}"
fail() { echo "$1" >&2; exit 1; }

[[ "$MODE" == "--verify-input" || "$MODE" == "--run" ]] || fail "usage: $0 --verify-input|--run <private-smoke-input.json>"
for command in curl git jq; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
[[ -s "$INPUT" ]] || fail "private smoke input is missing"
git -C "$ROOT_DIR" check-ignore -q -- "$INPUT" || fail "private smoke input must remain ignored"
[[ "$(stat -f '%Lp' "$INPUT")" == "600" ]] || fail "private smoke input must use mode 0600"
jq -e '
  (keys|sort)==(["accessToken","baseUrl","contractVersion","requests"]|sort)
  and .contractVersion=="1.0"
  and (.baseUrl|type=="string" and test("^https?://[^/@]+(:[0-9]+)?$") and length<256)
  and (.accessToken|type=="string" and length>=16)
  and (.requests|keys|sort)==(["dashboardAssistant","queryAi"]|sort)
  and (.requests.queryAi|type=="object")
  and (.requests.dashboardAssistant|type=="object")
' "$INPUT" >/dev/null || fail "private smoke input contract is invalid"
[[ "$MODE" == "--verify-input" ]] && { echo "ai_gateway_live_smoke_input=ready live_request=false"; exit 0; }
[[ "${ASKLAKE_AI_GATEWAY_SMOKE_CONFIRM:-}" == "run-reviewed-ai-gateway-smoke" ]] || \
  fail "set ASKLAKE_AI_GATEWAY_SMOKE_CONFIRM=run-reviewed-ai-gateway-smoke"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
base_url="$(jq -r '.baseUrl|sub("/$";"")' "$INPUT")"
jq -r '"header = Authorization: Bearer \(.accessToken)\nheader = Content-Type: application/json"' "$INPUT" >"$temporary_directory/curl.conf"
jq -c '.requests.queryAi' "$INPUT" >"$temporary_directory/query.json"
jq -c '.requests.dashboardAssistant' "$INPUT" >"$temporary_directory/dashboard.json"

curl --fail --silent --show-error --max-time 30 "$base_url/api/health/ai" >"$temporary_directory/health.json"
jq -e '.ok==true and .status=="ready"' "$temporary_directory/health.json" >/dev/null || fail "Backend AI readiness is not ready"
curl --fail --silent --show-error --max-time 60 --config "$temporary_directory/curl.conf" \
  --request POST --data-binary "@$temporary_directory/query.json" "$base_url/api/query/ai-suggestions" >"$temporary_directory/query-response.json"
jq -e '(.sql|type=="string" and length>0) and (.provider|type=="string" and length>0) and (.model|type=="string" and length>0)' \
  "$temporary_directory/query-response.json" >/dev/null || fail "Query AI did not return a provider-backed SQL suggestion"
curl --fail --silent --show-error --max-time 60 --config "$temporary_directory/curl.conf" \
  --request POST --data-binary "@$temporary_directory/dashboard.json" "$base_url/api/dashboards/assistant" >"$temporary_directory/dashboard-response.json"
jq -e '(.message|type=="string" and length>0) and (.provider|type=="string" and length>0) and (.model|type=="string" and length>0)' \
  "$temporary_directory/dashboard-response.json" >/dev/null || fail "Dashboard Assistant did not return a provider-backed response"
echo "ai_gateway_live_smoke=passed readiness=ready query_ai=passed dashboard_assistant=passed"
