#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
FIXTURE_DIR="$TEMP_DIR/fixtures"
EVIDENCE_DIR="$TEMP_DIR/evidence"
trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$FIXTURE_DIR" "$EVIDENCE_DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=asklake-realtime-v2-test-ca' \
  -keyout "$TEMP_DIR/ca.key" -out "$TEMP_DIR/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj '/CN=clickhouse-v2' \
  -addext 'subjectAltName=DNS:clickhouse-v2,DNS:clickhouse-v2.asklake-dev.svc.cluster.local' \
  -keyout "$TEMP_DIR/server.key" -out "$TEMP_DIR/server.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$TEMP_DIR/server.csr" \
  -CA "$TEMP_DIR/ca.crt" -CAkey "$TEMP_DIR/ca.key" -CAcreateserial \
  -copy_extensions copy -out "$TEMP_DIR/server.crt" >/dev/null 2>&1

admin_fixture='test-admin-fixture-value-01'
ingest_fixture='test-ingest-fixture-value-02'
materializer_fixture='test-materializer-fixture-value-03'
migration_fixture='test-migration-fixture-value-04'
observer_fixture='test-observer-fixture-value-05'
reader_fixture='test-reader-fixture-value-06'

external_secret_fixture() {
  local name="$1"
  jq -n --arg name "$name" '{
    apiVersion:"external-secrets.io/v1",
    kind:"ExternalSecret",
    metadata:{name:$name},
    spec:{
      secretStoreRef:{kind:"SecretStore",name:"asklake-secrets-manager"},
      target:{name:$name,creationPolicy:"Owner",deletionPolicy:"Retain"}
    },
    status:{conditions:[{type:"Ready",status:"True"}]}
  }' >"$FIXTURE_DIR/externalsecret-$name.json"
}

wrap_secret() {
  local name="$1"
  local data_file="$2"
  jq -n --arg name "$name" --slurpfile data "$data_file" '{
    apiVersion:"v1",
    kind:"Secret",
    metadata:{name:$name,ownerReferences:[{
      apiVersion:"external-secrets.io/v1",
      kind:"ExternalSecret",
      name:$name,
      controller:true
    }]},
    type:"Opaque",
    data:$data[0]
  }' >"$FIXTURE_DIR/secret-$name.json"
}

for name in \
  asklake-clickhouse-keeper-v2-config \
  asklake-clickhouse-v2-config \
  asklake-kafka-connect-v2-runtime \
  asklake-realtime-runtime; do
  external_secret_fixture "$name"
done

jq -n --rawfile keeper "$ROOT_DIR/deploy/clickhouse-v2/keeper-config.xml" \
  '{"keeper.xml":($keeper|@base64)}' >"$TEMP_DIR/keeper-data.json"
wrap_secret asklake-clickhouse-keeper-v2-config "$TEMP_DIR/keeper-data.json"

jq -n \
  --rawfile tls "$ROOT_DIR/deploy/clickhouse-v2/config.d/tls.xml" \
  --rawfile keeper "$ROOT_DIR/deploy/clickhouse-v2/config.d/keeper.xml" \
  --rawfile ca "$TEMP_DIR/ca.crt" \
  --rawfile certificate "$TEMP_DIR/server.crt" \
  --rawfile privateKey "$TEMP_DIR/server.key" \
  --arg admin "$admin_fixture" \
  --arg ingest "$ingest_fixture" \
  --arg materializer "$materializer_fixture" \
  --arg migration "$migration_fixture" \
  --arg observer "$observer_fixture" \
  --arg reader "$reader_fixture" \
  '{
    "tls.xml":($tls|@base64),
    "keeper.xml":($keeper|@base64),
    "ca.crt":($ca|@base64),
    "server.crt":($certificate|@base64),
    "server.key":($privateKey|@base64),
    adminPassword:($admin|@base64),
    ingestPassword:($ingest|@base64),
    materializerPassword:($materializer|@base64),
    migrationPassword:($migration|@base64),
    observerPassword:($observer|@base64),
    readerPassword:($reader|@base64)
  }' >"$TEMP_DIR/clickhouse-data.json"
wrap_secret asklake-clickhouse-v2-config "$TEMP_DIR/clickhouse-data.json"

jq -n \
  --rawfile ca "$TEMP_DIR/ca.crt" \
  --arg ingest "$ingest_fixture" \
  '{
    CONNECT_BOOTSTRAP_SERVERS:("broker:9098"|@base64),
    CONNECT_GROUP_ID:("test-connect-v2"|@base64),
    CONNECT_CONFIG_STORAGE_TOPIC:("test-connect-config"|@base64),
    CONNECT_OFFSET_STORAGE_TOPIC:("test-connect-offset"|@base64),
    CONNECT_STATUS_STORAGE_TOPIC:("test-connect-status"|@base64),
    CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR:("1"|@base64),
    CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR:("1"|@base64),
    CONNECT_STATUS_STORAGE_REPLICATION_FACTOR:("1"|@base64),
    CONNECT_CONFIG_PROVIDERS:("file"|@base64),
    CONNECT_CONFIG_PROVIDERS_FILE_CLASS:("org.apache.kafka.common.config.provider.FileConfigProvider"|@base64),
    CONNECT_CONNECTOR_CLIENT_CONFIG_OVERRIDE_POLICY:("All"|@base64),
    CONNECT_KEY_CONVERTER:("org.apache.kafka.connect.json.JsonConverter"|@base64),
    CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE:("false"|@base64),
    CONNECT_VALUE_CONVERTER:("org.apache.kafka.connect.json.JsonConverter"|@base64),
    CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE:("false"|@base64),
    CONNECT_PLUGIN_PATH:("/usr/share/java,/usr/share/confluent-hub-components"|@base64),
    CONNECT_REST_ADVERTISED_HOST_NAME:("kafka-connect-v2"|@base64),
    CONNECT_REST_PORT:("8083"|@base64),
    CONNECT_SECURITY_PROTOCOL:("SASL_SSL"|@base64),
    CONNECT_SASL_MECHANISM:("AWS_MSK_IAM"|@base64),
    CONNECT_SASL_JAAS_CONFIG:("software.amazon.msk.auth.iam.IAMLoginModule required;"|@base64),
    CONNECT_SASL_CLIENT_CALLBACK_HANDLER_CLASS:("software.amazon.msk.auth.iam.IAMClientCallbackHandler"|@base64),
    CONNECT_CUB_KAFKA_TIMEOUT:("120"|@base64),
    KAFKA_HEAP_OPTS:("-Xms256M -Xmx1G"|@base64),
    ASKLAKE_MSK_IAM_AUTH_JAR:("/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar"|@base64),
    ASKLAKE_V2_SOURCE_TOPIC:("test-source"|@base64),
    ASKLAKE_V2_DLQ_TOPIC:("test-source.asklake-v2-dlq"|@base64),
    "asklake-clickhouse-v2.properties":(("clickhouse.ingest."+"pass"+"word="+$ingest+"\n")|@base64),
    "clickhouse-v2-ca.crt":($ca|@base64)
  }' >"$TEMP_DIR/connect-data.json"
wrap_secret asklake-kafka-connect-v2-runtime "$TEMP_DIR/connect-data.json"

jq -n \
  --rawfile ca "$TEMP_DIR/ca.crt" \
  --arg materializer "$materializer_fixture" \
  --arg reader "$reader_fixture" \
  '{
    CLICKHOUSE_V2_MATERIALIZER_PASSWORD:($materializer|@base64),
    CLICKHOUSE_V2_READER_PASSWORD:($reader|@base64),
    "clickhouse-v2-ca.crt":($ca|@base64)
  }' >"$TEMP_DIR/backend-data.json"
wrap_secret asklake-realtime-runtime "$TEMP_DIR/backend-data.json"

cat >"$TEMP_DIR/kubectl" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
kind="$2"
name="$3"
case "$kind" in
  externalsecret) file="$ASKLAKE_SECRET_FIXTURE_DIR/externalsecret-$name.json" ;;
  secret) file="$ASKLAKE_SECRET_FIXTURE_DIR/secret-$name.json" ;;
  *) exit 2 ;;
esac
test -s "$file"
exec /bin/cat "$file"
SCRIPT
chmod 700 "$TEMP_DIR/kubectl"

run_verifier() {
  rm -rf "$EVIDENCE_DIR"
  mkdir -p "$EVIDENCE_DIR"
  ASKLAKE_KUBECTL_BIN="$TEMP_DIR/kubectl" \
  ASKLAKE_SECRET_FIXTURE_DIR="$FIXTURE_DIR" \
    "$ROOT_DIR/scripts/verify-eks-realtime-v2-secrets.sh" asklake-dev "$EVIDENCE_DIR"
}

run_verifier >/dev/null

cp "$FIXTURE_DIR/secret-asklake-clickhouse-v2-config.json" "$TEMP_DIR/clickhouse-valid.json"
jq '.data.readerPassword = .data.materializerPassword' \
  "$TEMP_DIR/clickhouse-valid.json" >"$FIXTURE_DIR/secret-asklake-clickhouse-v2-config.json"
if run_verifier >/dev/null 2>&1; then
  echo 'duplicate ClickHouse credential negative case unexpectedly passed' >&2
  exit 1
fi
cp "$TEMP_DIR/clickhouse-valid.json" "$FIXTURE_DIR/secret-asklake-clickhouse-v2-config.json"

cp "$FIXTURE_DIR/secret-asklake-realtime-runtime.json" "$TEMP_DIR/backend-valid.json"
jq '.data.CLICKHOUSE_V2_READER_PASSWORD = ("test-reader-mismatch-99" | @base64)' \
  "$TEMP_DIR/backend-valid.json" >"$FIXTURE_DIR/secret-asklake-realtime-runtime.json"
if run_verifier >/dev/null 2>&1; then
  echo 'FastAPI credential mismatch negative case unexpectedly passed' >&2
  exit 1
fi
cp "$TEMP_DIR/backend-valid.json" "$FIXTURE_DIR/secret-asklake-realtime-runtime.json"

cp "$FIXTURE_DIR/secret-asklake-kafka-connect-v2-runtime.json" "$TEMP_DIR/connect-valid.json"
jq '.data.ASKLAKE_V2_DLQ_TOPIC = ("legacy-dlq" | @base64)' \
  "$TEMP_DIR/connect-valid.json" >"$FIXTURE_DIR/secret-asklake-kafka-connect-v2-runtime.json"
if run_verifier >/dev/null 2>&1; then
  echo 'FastAPI-derived DLQ mismatch negative case unexpectedly passed' >&2
  exit 1
fi
cp "$TEMP_DIR/connect-valid.json" "$FIXTURE_DIR/secret-asklake-kafka-connect-v2-runtime.json"

jq '.data["asklake-clickhouse-v2.properties"] = ("clickhouse.ingest.password=test-ingest-mismatch-99\n" | @base64)' \
  "$TEMP_DIR/connect-valid.json" >"$FIXTURE_DIR/secret-asklake-kafka-connect-v2-runtime.json"
if run_verifier >/dev/null 2>&1; then
  echo 'Kafka Connect credential mismatch negative case unexpectedly passed' >&2
  exit 1
fi

echo 'EKS realtime V2 Secret/TLS binding positive and negative tests passed.'
