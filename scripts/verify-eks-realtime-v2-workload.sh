#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="$ROOT_DIR/infra/eks/helm/asklake-workloads"
VALUES_FILE="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
HELM_BIN="${HELM_BIN:-$(command -v helm)}"
DISABLED_RENDER="$(mktemp)"
ENABLED_RENDER="$(mktemp)"
RECOVERY_RENDER="$(mktemp)"
trap 'rm -f "$DISABLED_RENDER" "$ENABLED_RENDER" "$RECOVERY_RENDER"' EXIT

"$HELM_BIN" template asklake-v2 "$CHART_DIR" -f "$VALUES_FILE" >"$DISABLED_RENDER"
if grep -q 'app.kubernetes.io/component: realtime-v2-' "$DISABLED_RENDER"; then
  echo "Realtime V2 rendered while disabled" >&2
  exit 1
fi

if "$HELM_BIN" template asklake-v2 "$CHART_DIR" -f "$VALUES_FILE" --set realtimeV2.enabled=true >/dev/null 2>&1; then
  echo "Realtime V2 rendered without owner approval" >&2
  exit 1
fi
if "$HELM_BIN" template asklake-v2 "$CHART_DIR" -f "$VALUES_FILE" \
  --set realtimeV1.enabled=true --set realtimeV2.enabled=true >/dev/null 2>&1; then
  echo "Realtime V1 and V2 rendered concurrently" >&2
  exit 1
fi

render_args=(
  --set realtimeV2.enabled=true
  --set realtimeV2.ownerTransfer.approved=true
  --set realtimeV2.ownerTransfer.previousOwnerFenced=true
  --set-string realtimeV2.ownerTransfer.generation=v2-canary-g1
  --set-string realtimeV2.storage.storageClassName=gp3-encrypted
  --set-string realtimeV2.images.clickhouse.repository=example.invalid/clickhouse
  --set-string realtimeV2.images.clickhouse.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  --set-string realtimeV2.images.connect.repository=example.invalid/connect
  --set-string realtimeV2.images.connect.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  --set-string backend.image.repository=example.invalid/backend
  --set-string backend.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
)
"$HELM_BIN" template asklake-v2 "$CHART_DIR" -f "$VALUES_FILE" "${render_args[@]}" >"$ENABLED_RENDER"

if "$HELM_BIN" template asklake-v2-restore "$CHART_DIR" -f "$VALUES_FILE" "${render_args[@]}" \
  --set realtimeV2.recoveryMode=true \
  --set-string realtimeV2.storage.restoreSnapshots.clickhouse=clickhouse-v2-snapshot-g1 \
  >/dev/null 2>&1; then
  echo "Realtime V2 recovery rendered with only one snapshot" >&2
  exit 1
fi
if "$HELM_BIN" template asklake-v2 "$CHART_DIR" -f "$VALUES_FILE" "${render_args[@]}" \
  --set-string realtimeV2.storage.restoreSnapshots.clickhouse=clickhouse-v2-snapshot-g1 \
  --set-string realtimeV2.storage.restoreSnapshots.keeper=keeper-v2-snapshot-g1 \
  >/dev/null 2>&1; then
  echo "Realtime V2 active mode accepted restore snapshots" >&2
  exit 1
fi
"$HELM_BIN" template asklake-v2-restore "$CHART_DIR" -f "$VALUES_FILE" "${render_args[@]}" \
  --set realtimeV2.recoveryMode=true \
  --set-string realtimeV2.storage.restoreSnapshots.clickhouse=clickhouse-v2-snapshot-g1 \
  --set-string realtimeV2.storage.restoreSnapshots.keeper=keeper-v2-snapshot-g1 \
  >"$RECOVERY_RENDER"

for name in clickhouse-keeper-v2 clickhouse-v2 kafka-connect-v2 asklake-realtime-v2-worker; do
  grep -q "name: $name" "$ENABLED_RENDER"
done
test "$(grep -c '^kind: StatefulSet$' "$ENABLED_RENDER")" -eq 2
test "$(grep -c 'persistentVolumeClaimRetentionPolicy:' "$ENABLED_RENDER")" -eq 2
test "$(grep -c 'whenDeleted: Retain' "$ENABLED_RENDER")" -eq 2
test "$(grep -c 'storageClassName: \"gp3-encrypted\"' "$ENABLED_RENDER")" -eq 2
grep -q 'serviceAccountName: asklake-realtime-v2-connect' "$ENABLED_RENDER"
grep -q 'serviceAccountName: asklake-realtime-v2-worker' "$ENABLED_RENDER"
grep -q 'value: "asklake.eks-realtime.v2.fixture.v2-canary-g1"' "$ENABLED_RENDER"
grep -q 'value: "asklake.eks-realtime.v2.dlq.v2-canary-g1"' "$ENABLED_RENDER"
grep -q 'value: "asklake-connect-v2-v2-canary-g1-offset"' "$ENABLED_RENDER"
grep -q 'value: "asklake-eks-realtime-v2-worker-v2-canary-g1"' "$ENABLED_RENDER"
grep -q 'value: AWS_MSK_IAM' "$ENABLED_RENDER"
grep -q 'software.amazon.msk.auth.iam.IAMClientCallbackHandler' "$ENABLED_RENDER"
grep -q 'name: ASKLAKE_MSK_IAM_AUTH_JAR' "$ENABLED_RENDER"
grep -q 'value: "/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar"' "$ENABLED_RENDER"
grep -q 'value: "/usr/share/java,/usr/share/confluent-hub-components"' "$ENABLED_RENDER"
grep -q 'name: CLICKHOUSE_REALTIME_CONSUMER_OWNER' "$ENABLED_RENDER"
grep -q 'value: kafka_connect_v2' "$ENABLED_RENDER"
grep -q 'secretKeyRef:' "$ENABLED_RENDER"

test "$(grep -c '^kind: StatefulSet$' "$RECOVERY_RENDER")" -eq 2
test "$(grep -c 'kind: VolumeSnapshot' "$RECOVERY_RENDER")" -eq 2
grep -q 'name: "clickhouse-v2-snapshot-g1"' "$RECOVERY_RENDER"
grep -q 'name: "keeper-v2-snapshot-g1"' "$RECOVERY_RENDER"
if grep -Eq 'serviceAccountName: asklake-realtime-v2-(connect|worker)|app.kubernetes.io/component: realtime-v2-(connect|worker)' "$RECOVERY_RENDER"; then
  echo "Realtime V2 isolated recovery must not render a Kafka consumer" >&2
  exit 1
fi

if grep -Eq '^kind: Secret$|replace-with-clickhouse|password: [^{$]' "$ENABLED_RENDER"; then
  echo "Realtime V2 render contains a Secret resource or plaintext credential" >&2
  exit 1
fi
if grep -Eq 'image: ".+:(latest|main|dev)"' "$ENABLED_RENDER"; then
  echo "Realtime V2 render contains a mutable image" >&2
  exit 1
fi
if grep -q '/usr/share/java/aws-msk-iam-auth' "$ENABLED_RENDER"; then
  echo "MSK IAM auth JAR must not be placed on Kafka Connect's plugin path" >&2
  exit 1
fi

grep -q 'ADD --checksum=sha256:de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c08' \
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"
grep -q 'ENV CLASSPATH=/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar' \
  "$ROOT_DIR/deploy/kafka-connect/Dockerfile"

echo "EKS Realtime V2 workload contract verification passed."
