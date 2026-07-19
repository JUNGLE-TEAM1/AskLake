#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REALTIME_CHART="$ROOT_DIR/infra/eks/helm/asklake-realtime-data-plane"
REALTIME_VALUES="$ROOT_DIR/infra/eks/values/workloads/realtime-data-plane.test.example.yaml"
WORKLOAD_CHART="$ROOT_DIR/infra/eks/helm/asklake-workloads"
WORKLOAD_VALUES="$ROOT_DIR/infra/eks/values/workloads/dev.example.yaml"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

require_failure() {
  local label="$1"
  shift
  if "$@" >"$TEMP_DIR/negative.out" 2>&1; then
    echo "negative case unexpectedly passed: $label" >&2
    exit 1
  fi
}

helm lint "$REALTIME_CHART"
helm lint "$REALTIME_CHART" -f "$REALTIME_VALUES"

helm template asklake-realtime "$REALTIME_CHART" >"$TEMP_DIR/disabled.yaml"
if grep -q '^kind:' "$TEMP_DIR/disabled.yaml"; then
  echo "disabled realtime chart rendered Kubernetes resources" >&2
  exit 1
fi

helm template asklake-realtime "$REALTIME_CHART" \
  -f "$REALTIME_VALUES" >"$TEMP_DIR/shadow.yaml"

helm template asklake-realtime "$REALTIME_CHART" \
  -f "$REALTIME_VALUES" \
  --set kafkaConnect.createServiceAccount=true >"$TEMP_DIR/shadow-new-environment.yaml"

helm template asklake-realtime "$REALTIME_CHART" \
  -f "$REALTIME_VALUES" \
  --set mode=cutover \
  --set ownership.canonicalOwner=eks-continuous-worker-v2 \
  --set ownership.ec2Quiesced=true \
  --set ownership.ec2KafkaOwnerReady=false \
  --set ownership.realtimeV1Fenced=false \
  --set ownership.transferApproved=true \
  --set ownership.generation=test-g1 \
  --set continuousWorker.replicas=1 >"$TEMP_DIR/cutover.yaml"

kubectl create --dry-run=client -f "$TEMP_DIR/cutover.yaml" -o json \
  | jq -s '.' >"$TEMP_DIR/cutover-objects.json"

test "$(grep -c '^kind: StatefulSet$' "$TEMP_DIR/shadow.yaml")" -eq 2
test "$(grep -c '^kind: Deployment$' "$TEMP_DIR/shadow.yaml")" -eq 1
test "$(grep -c '^kind: Service$' "$TEMP_DIR/shadow.yaml")" -eq 3
test "$(grep -c '^kind: ServiceAccount$' "$TEMP_DIR/shadow.yaml")" -eq 1
test "$(grep -c '^kind: ServiceAccount$' "$TEMP_DIR/shadow-new-environment.yaml")" -eq 2
grep -q 'name: asklake-realtime-v2-connect' "$TEMP_DIR/shadow-new-environment.yaml"
test "$(grep -c '^kind: NetworkPolicy$' "$TEMP_DIR/shadow.yaml")" -eq 5
test "$(grep -c '^kind: Deployment$' "$TEMP_DIR/cutover.yaml")" -eq 2
test "$(grep -c '^kind: NetworkPolicy$' "$TEMP_DIR/cutover.yaml")" -eq 6
jq -e '
  (.[] | select(.kind == "Deployment" and .metadata.name == "kafka-connect-v2")
    | .spec.template.spec.automountServiceAccountToken == false
      and .spec.template.spec.serviceAccountName == "asklake-realtime-v2-connect")
  and
  (.[] | select(.kind == "Deployment" and .metadata.name == "asklake-continuous-worker")
    | .spec.template.spec.automountServiceAccountToken == false)
  and
  ([.[] | select(.kind == "NetworkPolicy" and .metadata.name == "asklake-realtime-continuous-worker")
    | .spec.egress[].ports[].port] | sort == [5432, 8083, 8443])
' "$TEMP_DIR/cutover-objects.json" >/dev/null
jq -n -e '
  [
    {kind:"StatefulSet",name:"clickhouse-keeper-v2",component:"realtime-v2-keeper"},
    {kind:"StatefulSet",name:"clickhouse-v2",component:"realtime-v2-clickhouse"},
    {kind:"Deployment",name:"kafka-connect-v2",component:"realtime-v2-connect"}
  ]
  | map(. as $expected
      | any($objects[0][];
        .kind == $expected.kind
        and .metadata.name == $expected.name
        and .spec.selector.matchLabels == {
          "app.kubernetes.io/name":"asklake-workloads",
          "app.kubernetes.io/instance":"asklake-realtime",
          "app.kubernetes.io/component":$expected.component
        }))
  | all
' --slurpfile objects "$TEMP_DIR/cutover-objects.json" >/dev/null

if grep -q 'name: asklake-continuous-worker' "$TEMP_DIR/shadow.yaml"; then
  echo "shadow mode rendered the Continuous worker" >&2
  exit 1
fi

for forbidden in \
  'serviceName: asklake-clickhouse-v2' \
  'serviceName: asklake-clickhouse-keeper-v2'; do
  if grep -Fq "$forbidden" "$TEMP_DIR/shadow.yaml"; then
    echo "canonical render would create a second V2 resource identity: $forbidden" >&2
    exit 1
  fi
done
test "$(grep -c 'whenDeleted: Retain' "$TEMP_DIR/shadow.yaml")" -eq 2
test "$(grep -c 'whenScaled: Retain' "$TEMP_DIR/shadow.yaml")" -eq 2

for expected in \
  'name: asklake-continuous-worker' \
  'name: ASKLAKE_CONTINUOUS_CONTROL_PLANE, value: local' \
  'name: CONTINUOUS_CONTROL_PLANE, value: worker' \
  'name: CONTINUOUS_WORKER_SCOPE, value: continuous_sql' \
  'name: CONTINUOUS_WORKER_OWNER, value: eks-continuous-worker-v2' \
  'name: CONTINUOUS_WORKER_GENERATION, value: "test-g1"' \
  'name: CLICKHOUSE_REALTIME_CONSUMER_OWNER, value: kafka_connect_v2' \
  'name: CLICKHOUSE_V2_MATERIALIZER_PASSWORD' \
  'name: CLICKHOUSE_V2_READER_PASSWORD' \
  'name: CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR' \
  'name: CONNECT_CONFIG_PROVIDERS_FILE_CLASS' \
  'name: CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE' \
  'name: ASKLAKE_MSK_IAM_AUTH_JAR' \
  'name: ASKLAKE_V2_SOURCE_TOPIC' \
  'name: ASKLAKE_V2_DLQ_TOPIC' \
  'name: asklake-runtime' \
  'serviceAccountName: asklake-backend'; do
  grep -q "$expected" "$TEMP_DIR/cutover.yaml"
done

for expected in \
  'storageClassName: "gp3"' \
  'mountPath: /var/lib/clickhouse' \
  'mountPath: /var/lib/clickhouse-keeper' \
  'name: clickhouse-v2' \
  'name: clickhouse-keeper-v2' \
  'name: kafka-connect-v2' \
  'name: clickhouse-data' \
  'name: keeper-data' \
  'persistentVolumeClaimRetentionPolicy:' \
  'name: asklake-clickhouse-v2' \
  'serviceAccountName: asklake-realtime-v2-connect' \
  'automountServiceAccountToken: false' \
  'name: CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS' \
  'name: CLICKHOUSE_V2_TLS_STAGING_REQUIRED' \
  'name: CLICKHOUSE_V2_INGEST_PASSWORD' \
  'name: CLICKHOUSE_V2_MATERIALIZER_PASSWORD' \
  'name: CLICKHOUSE_V2_READER_PASSWORD' \
  'fsGroup: 101' \
  'fsGroupChangePolicy: OnRootMismatch' \
  'runAsUser: 101' \
  'defaultMode: 0440' \
  'mountPath: /run/asklake-secrets-source/clickhouse-v2' \
  'mountPath: /run/asklake-clickhouse-v2-secrets' \
  'port: 9098' \
  '169.254.170.23/32'; do
  grep -q "$expected" "$TEMP_DIR/shadow.yaml"
done

if grep -Eq '(password|private.?key):[[:space:]]+[^<{[:space:]]' "$TEMP_DIR/shadow.yaml"; then
  echo "rendered realtime chart appears to contain a literal secret" >&2
  exit 1
fi

require_failure "shadow worker" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set continuousWorker.replicas=1
require_failure "cutover without ownership acknowledgement" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set mode=cutover --set continuousWorker.replicas=1
require_failure "cutover with a split EC2 Kafka owner" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set mode=cutover \
    --set ownership.canonicalOwner=eks-continuous-worker-v2 \
    --set ownership.ec2Quiesced=true \
    --set ownership.ec2KafkaOwnerReady=true \
    --set ownership.realtimeV1Fenced=false \
    --set ownership.transferApproved=true \
    --set ownership.generation=test-g1 \
    --set continuousWorker.replicas=1
require_failure "cutover with a fenced EKS Realtime V1 owner" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set mode=cutover \
    --set ownership.canonicalOwner=eks-continuous-worker-v2 \
    --set ownership.ec2Quiesced=true \
    --set ownership.ec2KafkaOwnerReady=false \
    --set ownership.realtimeV1Fenced=true \
    --set ownership.transferApproved=true \
    --set ownership.generation=test-g1 \
    --set continuousWorker.replicas=1
require_failure "cutover without a worker generation" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set mode=cutover \
    --set ownership.canonicalOwner=eks-continuous-worker-v2 \
    --set ownership.ec2Quiesced=true \
    --set ownership.ec2KafkaOwnerReady=false \
    --set ownership.realtimeV1Fenced=false \
    --set ownership.transferApproved=true \
    --set continuousWorker.replicas=1
require_failure "mutable image" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set clickhouse.image.digest=latest
require_failure "unsupported direct multi-node ClickHouse" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set clickhouse.replicas=2
require_failure "missing ClickHouse storage" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set-string clickhouse.storage.size=
require_failure "missing ClickHouse init credential key" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set-string clickhouse.configSecret.adminPasswordKey=
require_failure "disabled NetworkPolicy" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set networkPolicy.enabled=false
require_failure "wrong Kafka Connect ServiceAccount" \
  helm template asklake-realtime "$REALTIME_CHART" -f "$REALTIME_VALUES" \
    --set kafkaConnect.serviceAccountName=default

helm template asklake-workloads "$WORKLOAD_CHART" \
  -f "$WORKLOAD_VALUES" >"$TEMP_DIR/workloads-default.yaml"

grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "external_ec2"' "$TEMP_DIR/workloads-default.yaml"
grep -q 'CLICKHOUSE_REALTIME_V2_ENABLED: "false"' "$TEMP_DIR/workloads-default.yaml"
grep -q 'KAFKA_CONNECT_SINK_ENABLED: "false"' "$TEMP_DIR/workloads-default.yaml"
if grep -Eq '^kind: (StatefulSet|PersistentVolumeClaim|Secret)$' "$TEMP_DIR/workloads-default.yaml"; then
  echo "default asklake-workloads render gained a stateful realtime resource" >&2
  exit 1
fi

realtime_backend_args=(
  --set backend.realtime.enabled=true
  --set backend.realtime.apiControlPlane=local
  --set backend.realtime.continuousSqlJoinEnabled=true
  --set backend.realtime.dashboardSyncMode=sse
  --set backend.realtime.realtimeEventsEnabled=true
  --set backend.realtime.clickhouseRealtimeV2Enabled=true
  --set backend.realtime.kafkaConnectSinkEnabled=true
  --set backend.realtime.consumerOwner=kafka_connect_v2
  --set backend.realtime.kafkaConnectUrl=http://kafka-connect-v2:8083
  --set backend.realtime.clickhouseV2Url=https://clickhouse-v2:8443
)

helm template asklake-workloads "$WORKLOAD_CHART" -f "$WORKLOAD_VALUES" \
  "${realtime_backend_args[@]}" >"$TEMP_DIR/workloads-realtime.yaml"
grep -q 'ASKLAKE_CONTINUOUS_CONTROL_PLANE: "local"' "$TEMP_DIR/workloads-realtime.yaml"
grep -q 'CLICKHOUSE_REALTIME_V2_ENABLED: "true"' "$TEMP_DIR/workloads-realtime.yaml"
grep -q 'secretName: asklake-realtime-runtime' "$TEMP_DIR/workloads-realtime.yaml"
grep -q 'path: clickhouse-v2-ca.crt' "$TEMP_DIR/workloads-realtime.yaml"

require_failure "backend realtime without local API ownership" \
  helm template asklake-workloads "$WORKLOAD_CHART" -f "$WORKLOAD_VALUES" \
    "${realtime_backend_args[@]}" --set backend.realtime.apiControlPlane=external_ec2
require_failure "backend realtime with plaintext ClickHouse" \
  helm template asklake-workloads "$WORKLOAD_CHART" -f "$WORKLOAD_VALUES" \
    "${realtime_backend_args[@]}" --set backend.realtime.clickhouseV2Url=http://clickhouse-v2:8123
require_failure "backend realtime with disabled owner" \
  helm template asklake-workloads "$WORKLOAD_CHART" -f "$WORKLOAD_VALUES" \
    "${realtime_backend_args[@]}" --set backend.realtime.consumerOwner=disabled
require_failure "simultaneous EKS realtime V1 and V2" \
  helm template asklake-workloads "$WORKLOAD_CHART" -f "$WORKLOAD_VALUES" \
    "${realtime_backend_args[@]}" \
    --set realtimeV1.enabled=true \
    --set realtimeV1.ownerTransfer.approved=true \
    --set realtimeV1.ownerTransfer.previousOwnerFenced=true \
    --set realtimeV1.ownerTransfer.generation=v2-conflict-check

echo "EKS realtime data-plane schema and negative tests passed."
