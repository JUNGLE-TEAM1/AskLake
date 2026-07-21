#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
ENV_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
PROFILE_VALUES="$ROOT_DIR/deploy/profiles/realtime-v1-only.yaml"
WEB_CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-web"
WEB_ENV_VALUES="$ROOT_DIR/infra/eks/values/workloads/web.test.example.yaml"
WEB_PROFILE_VALUES="$ROOT_DIR/deploy/profiles/web-realtime-v1-only.yaml"
BASE_RENDER="$(mktemp)"
ACTIVE_RENDER="$(mktemp)"
WEB_RENDER="$(mktemp)"
WEB_ACTIVE_RENDER="$(mktemp)"
trap 'rm -f "$BASE_RENDER" "$ACTIVE_RENDER" "$WEB_RENDER" "$WEB_ACTIVE_RENDER"' EXIT

HELM_BIN="${ASKLAKE_HELM_BIN:-}"
if [[ -z "$HELM_BIN" ]] && command -v helm >/dev/null 2>&1; then
  HELM_BIN="$(command -v helm)"
fi
if [[ -z "$HELM_BIN" || ! -x "$HELM_BIN" ]]; then
  echo "helm is required to verify the EKS realtime V1-only profile" >&2
  exit 1
fi

for required_file in \
  "$CHART_DIR/Chart.yaml" \
  "$CHART_DIR/values.schema.json" \
  "$ENV_VALUES" \
  "$PROFILE_VALUES" \
  "$WEB_CHART_DIR/Chart.yaml" \
  "$WEB_CHART_DIR/values.schema.json" \
  "$WEB_ENV_VALUES" \
  "$WEB_PROFILE_VALUES"; do
  if [[ ! -s "$required_file" ]]; then
    echo "missing required V1-only profile file: $required_file" >&2
    exit 1
  fi
done

"$HELM_BIN" lint "$WEB_CHART_DIR" -f "$WEB_ENV_VALUES" -f "$WEB_PROFILE_VALUES"
"$HELM_BIN" template asklake-web-v1-only "$WEB_CHART_DIR" \
  -f "$WEB_ENV_VALUES" -f "$WEB_PROFILE_VALUES" >"$WEB_RENDER"

for safe_contract in \
  'name: ASKLAKE_CONTINUOUS_CONTROL_PLANE, value: "local"' \
  'name: CONTINUOUS_CONTROL_PLANE, value: "disabled"' \
  'name: KAFKA_CONTINUOUS_V1_API_ENABLED, value: "false"' \
  'name: KAFKA_CONTINUOUS_V1_OWNER_GENERATION, value: ""' \
  'name: CONTINUOUS_SQL_JOIN_ENABLED, value: "false"' \
  'name: DASHBOARD_SYNC_MODE, value: "polling"' \
  'name: REALTIME_EVENTS_ENABLED, value: "false"'; do
  grep -Fq "$safe_contract" "$WEB_RENDER" || {
    echo "V1-only web render is missing contract: $safe_contract" >&2
    exit 1
  }
done

"$HELM_BIN" template asklake-web-v1-only "$WEB_CHART_DIR" \
  -f "$WEB_ENV_VALUES" -f "$WEB_PROFILE_VALUES" \
  --set backend.realtime.v1ApiEnabled=true \
  --set-string backend.realtime.v1OwnerGeneration=v1-only-contract-g1 >"$WEB_ACTIVE_RENDER"
grep -Fq 'name: KAFKA_CONTINUOUS_V1_API_ENABLED, value: "true"' "$WEB_ACTIVE_RENDER"
grep -Fq 'name: KAFKA_CONTINUOUS_V1_OWNER_GENERATION, value: "v1-only-contract-g1"' "$WEB_ACTIVE_RENDER"

for invalid_v1_admission in \
  backend.realtime.v1ApiEnabled=true \
  backend.realtime.v1OwnerGeneration=v1-only-contract-g1; do
  if "$HELM_BIN" template asklake-web-v1-only "$WEB_CHART_DIR" \
    -f "$WEB_ENV_VALUES" -f "$WEB_PROFILE_VALUES" \
    --set "$invalid_v1_admission" >/dev/null 2>&1; then
    echo "V1-only web schema accepted incomplete V1 admission: $invalid_v1_admission" >&2
    exit 1
  fi
done

for unsafe_override in \
  deploymentProfile=standard \
  backend.realtime.enabled=true \
  backend.realtime.apiControlPlane=external_ec2 \
  backend.realtime.continuousSqlJoinEnabled=true \
  backend.realtime.realtimeEventsEnabled=true; do
  if "$HELM_BIN" template asklake-web-v1-only "$WEB_CHART_DIR" \
    -f "$WEB_ENV_VALUES" -f "$WEB_PROFILE_VALUES" \
    --set "$unsafe_override" >/dev/null 2>&1; then
    echo "V1-only web schema accepted unsafe override: $unsafe_override" >&2
    exit 1
  fi
done

"$HELM_BIN" lint "$CHART_DIR" -f "$ENV_VALUES" -f "$PROFILE_VALUES"
"$HELM_BIN" template asklake-v1-only "$CHART_DIR" \
  -f "$ENV_VALUES" -f "$PROFILE_VALUES" >"$BASE_RENDER"

# The profile is fail closed until an exact owner generation is approved.
test "$(grep -c 'name: asklake-realtime-v1-worker$' "$BASE_RENDER" || true)" -eq 0

"$HELM_BIN" template asklake-v1-only "$CHART_DIR" \
  -f "$ENV_VALUES" -f "$PROFILE_VALUES" \
  --set realtimeV1.enabled=true \
  --set realtimeV1.ownerTransfer.approved=true \
  --set realtimeV1.ownerTransfer.previousOwnerFenced=true \
  --set-string realtimeV1.ownerTransfer.generation=v1-only-contract-g1 >"$ACTIVE_RENDER"

test "$(grep -c 'name: asklake-realtime-v1-worker$' "$ACTIVE_RENDER")" -eq 1
test "$(grep -c '^kind: StatefulSet$' "$ACTIVE_RENDER" || true)" -eq 0
grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "local"' "$ACTIVE_RENDER"
grep -q 'CONTINUOUS_CONTROL_PLANE: "disabled"' "$ACTIVE_RENDER"
grep -q 'name: CONTINUOUS_WORKER_SCOPE, value: "all"' "$ACTIVE_RENDER"
grep -q 'mountPath: /var/run/asklake/secrets' "$ACTIVE_RENDER"
grep -q 'secretName: asklake-backend-runtime' "$ACTIVE_RENDER"
grep -q 'path: trino-ca.pem' "$ACTIVE_RENDER"

if "$HELM_BIN" template asklake-v1-only "$CHART_DIR" \
  -f "$ENV_VALUES" -f "$PROFILE_VALUES" \
  --set realtimeV1.enabled=true >/dev/null 2>&1; then
  echo "V1-only rendered without an approved exact-one owner transfer" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-standard "$CHART_DIR" \
  -f "$ENV_VALUES" \
  --set backend.realtime.apiControlPlane=local >/dev/null 2>&1; then
  echo "standard disabled profile accepted the V1-only local API boundary" >&2
  exit 1
fi

for unsafe_override in \
  backend.realtime.enabled=true \
  backend.realtime.apiControlPlane=external_ec2 \
  backend.realtime.continuousSqlJoinEnabled=true; do
  if "$HELM_BIN" template asklake-v1-only "$CHART_DIR" \
    -f "$ENV_VALUES" -f "$PROFILE_VALUES" \
    --set "$unsafe_override" >/dev/null 2>&1; then
    echo "V1-only schema accepted unsafe override: $unsafe_override" >&2
    exit 1
  fi
done

echo "EKS realtime V1-only profile verification passed."
