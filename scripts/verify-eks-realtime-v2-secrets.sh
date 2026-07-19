#!/usr/bin/env bash
set -euo pipefail
set +x

NAMESPACE="${1:-${ASKLAKE_EKS_NAMESPACE:-asklake-dev}}"
EVIDENCE_DIR="${2:-}"
KUBECTL_BIN="${ASKLAKE_KUBECTL_BIN:-kubectl}"
OWN_TEMP=false

fail() {
  echo "$1" >&2
  exit 1
}

for command in grep jq openssl "$KUBECTL_BIN"; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

if [[ -z "$EVIDENCE_DIR" ]]; then
  EVIDENCE_DIR="$(mktemp -d)"
  OWN_TEMP=true
else
  mkdir -p "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
fi
if [[ "$OWN_TEMP" == "true" ]]; then
  trap 'rm -rf "$EVIDENCE_DIR"' EXIT
fi

verify_target() {
  local name="$1"
  local expected_keys_json="$2"
  local external_secret_file="$EVIDENCE_DIR/${name}-externalsecret.json"
  local target_secret_file="$EVIDENCE_DIR/${name}-secret.json"

  "$KUBECTL_BIN" get externalsecret "$name" -n "$NAMESPACE" -o json >"$external_secret_file" \
    || fail "missing realtime ExternalSecret: $name"
  "$KUBECTL_BIN" get secret "$name" -n "$NAMESPACE" -o json >"$target_secret_file" \
    || fail "missing realtime target Secret: $name"
  chmod 600 "$external_secret_file" "$target_secret_file"

  jq -e --arg name "$name" '
    any(.status.conditions[]?; .type == "Ready" and .status == "True")
    and .spec.secretStoreRef == {kind: "SecretStore", name: "asklake-secrets-manager"}
    and .spec.target.name == $name
    and .spec.target.creationPolicy == "Owner"
    and .spec.target.deletionPolicy == "Retain"
  ' "$external_secret_file" >/dev/null \
    || fail "realtime ExternalSecret is not Ready or violates its ownership contract: $name"

  jq -e --arg name "$name" --argjson expectedKeys "$expected_keys_json" '
    .type == "Opaque"
    and ((.data | keys | sort) == ($expectedKeys | sort))
    and any(.metadata.ownerReferences[]?;
      (.apiVersion | startswith("external-secrets.io/"))
      and .kind == "ExternalSecret"
      and .name == $name
      and .controller == true
    )
  ' "$target_secret_file" >/dev/null \
    || fail "realtime target Secret owner or key contract is invalid: $name"
}

verify_target asklake-clickhouse-keeper-v2-config '["keeper.xml"]'
verify_target asklake-clickhouse-v2-config \
  '["tls.xml","keeper.xml","ca.crt","server.crt","server.key","adminPassword","ingestPassword","materializerPassword","migrationPassword","observerPassword","readerPassword"]'
verify_target asklake-kafka-connect-v2-runtime \
  '["CONNECT_BOOTSTRAP_SERVERS","CONNECT_GROUP_ID","CONNECT_CONFIG_STORAGE_TOPIC","CONNECT_OFFSET_STORAGE_TOPIC","CONNECT_STATUS_STORAGE_TOPIC","CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR","CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR","CONNECT_STATUS_STORAGE_REPLICATION_FACTOR","CONNECT_CONFIG_PROVIDERS","CONNECT_CONFIG_PROVIDERS_FILE_CLASS","CONNECT_CONNECTOR_CLIENT_CONFIG_OVERRIDE_POLICY","CONNECT_KEY_CONVERTER","CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE","CONNECT_VALUE_CONVERTER","CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE","CONNECT_PLUGIN_PATH","CONNECT_REST_ADVERTISED_HOST_NAME","CONNECT_REST_PORT","CONNECT_SECURITY_PROTOCOL","CONNECT_SASL_MECHANISM","CONNECT_SASL_JAAS_CONFIG","CONNECT_SASL_CLIENT_CALLBACK_HANDLER_CLASS","CONNECT_CUB_KAFKA_TIMEOUT","KAFKA_HEAP_OPTS","ASKLAKE_MSK_IAM_AUTH_JAR","ASKLAKE_V2_SOURCE_TOPIC","ASKLAKE_V2_DLQ_TOPIC","asklake-clickhouse-v2.properties","clickhouse-v2-ca.crt"]'
verify_target asklake-realtime-runtime \
  '["CLICKHOUSE_V2_MATERIALIZER_PASSWORD","CLICKHOUSE_V2_READER_PASSWORD","clickhouse-v2-ca.crt"]'

jq -e '
  def decoded($key): .data[$key] | @base64d;
  (decoded("CONNECT_BOOTSTRAP_SERVERS") | test("^[^,[:space:]]+:9098(?:,[^,[:space:]]+:9098)*$"))
  and decoded("CONNECT_SECURITY_PROTOCOL") == "SASL_SSL"
  and decoded("CONNECT_SASL_MECHANISM") == "AWS_MSK_IAM"
  and decoded("CONNECT_SASL_JAAS_CONFIG") == "software.amazon.msk.auth.iam.IAMLoginModule required;"
  and decoded("CONNECT_SASL_CLIENT_CALLBACK_HANDLER_CLASS") == "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
  and decoded("CONNECT_CONFIG_PROVIDERS") == "file"
  and decoded("CONNECT_CONFIG_PROVIDERS_FILE_CLASS") == "org.apache.kafka.common.config.provider.FileConfigProvider"
  and decoded("CONNECT_CONNECTOR_CLIENT_CONFIG_OVERRIDE_POLICY") == "All"
  and decoded("CONNECT_KEY_CONVERTER") == "org.apache.kafka.connect.json.JsonConverter"
  and decoded("CONNECT_VALUE_CONVERTER") == "org.apache.kafka.connect.json.JsonConverter"
  and decoded("CONNECT_KEY_CONVERTER_SCHEMAS_ENABLE") == "false"
  and decoded("CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE") == "false"
  and decoded("CONNECT_REST_ADVERTISED_HOST_NAME") == "kafka-connect-v2"
  and decoded("CONNECT_REST_PORT") == "8083"
  and decoded("ASKLAKE_MSK_IAM_AUTH_JAR") == "/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar"
  and ([decoded("CONNECT_CONFIG_STORAGE_REPLICATION_FACTOR"),decoded("CONNECT_OFFSET_STORAGE_REPLICATION_FACTOR"),decoded("CONNECT_STATUS_STORAGE_REPLICATION_FACTOR")]
    | all(.[]; test("^[1-9][0-9]*$")))
  and ([decoded("CONNECT_GROUP_ID"),decoded("CONNECT_CONFIG_STORAGE_TOPIC"),decoded("CONNECT_OFFSET_STORAGE_TOPIC"),decoded("CONNECT_STATUS_STORAGE_TOPIC"),decoded("ASKLAKE_V2_SOURCE_TOPIC"),decoded("ASKLAKE_V2_DLQ_TOPIC")]
    | all(.[]; test("^[A-Za-z0-9._-]+$")) and (unique | length) == 6)
  and (decoded("ASKLAKE_V2_SOURCE_TOPIC") | length) <= 233
  and decoded("ASKLAKE_V2_DLQ_TOPIC") == (decoded("ASKLAKE_V2_SOURCE_TOPIC") + ".asklake-v2-dlq")
' "$EVIDENCE_DIR/asklake-kafka-connect-v2-runtime-secret.json" >/dev/null \
  || fail "Kafka Connect V2 runtime settings violate the MSK IAM, converter, REST, or FastAPI-derived DLQ contract"

jq -r '.data["ca.crt"] | @base64d' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  >"$EVIDENCE_DIR/clickhouse-v2-ca.crt"
jq -r '.data["server.crt"] | @base64d' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  >"$EVIDENCE_DIR/clickhouse-v2-server.crt"
chmod 600 "$EVIDENCE_DIR/clickhouse-v2-ca.crt" "$EVIDENCE_DIR/clickhouse-v2-server.crt"

jq -r '.data["tls.xml"] | @base64d' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  >"$EVIDENCE_DIR/clickhouse-v2-tls.xml"
jq -r '.data["keeper.xml"] | @base64d' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  >"$EVIDENCE_DIR/clickhouse-v2-keeper.xml"
chmod 600 "$EVIDENCE_DIR/clickhouse-v2-tls.xml" "$EVIDENCE_DIR/clickhouse-v2-keeper.xml"
for marker in \
  '<http_port remove="remove"/>' \
  '<https_port>8443</https_port>' \
  '<tcp_port_secure>9440</tcp_port_secure>' \
  '<interserver_https_port>9010</interserver_https_port>' \
  '/run/asklake-clickhouse-v2-secrets/server.crt' \
  '/run/asklake-clickhouse-v2-secrets/server.key' \
  '/run/asklake-clickhouse-v2-secrets/ca.crt'; do
  grep -Fq "$marker" "$EVIDENCE_DIR/clickhouse-v2-tls.xml" \
    || fail "ClickHouse V2 TLS config is missing a required secure-listener marker"
done
grep -Fq '<host>clickhouse-keeper-v2</host>' "$EVIDENCE_DIR/clickhouse-v2-keeper.xml" \
  || fail "ClickHouse V2 server config does not reference the canonical Keeper Service"

openssl verify -CAfile "$EVIDENCE_DIR/clickhouse-v2-ca.crt" \
  "$EVIDENCE_DIR/clickhouse-v2-server.crt" >/dev/null
openssl x509 -in "$EVIDENCE_DIR/clickhouse-v2-server.crt" -noout \
  -checkhost clickhouse-v2 >/dev/null
openssl x509 -in "$EVIDENCE_DIR/clickhouse-v2-server.crt" -noout \
  -checkhost "clickhouse-v2.${NAMESPACE}.svc.cluster.local" >/dev/null

jq -e '
  ([.data.adminPassword,.data.ingestPassword,.data.materializerPassword,.data.migrationPassword,.data.observerPassword,.data.readerPassword]
    | map(@base64d)) as $passwords
  | all($passwords[]; (length >= 16) and (contains("replace-with-") | not))
  and (($passwords | unique | length) == 6)
' "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" >/dev/null \
  || fail "ClickHouse V2 account passwords must be non-placeholder length and pairwise distinct"

jq -e '
  (.data.CLICKHOUSE_V2_MATERIALIZER_PASSWORD | @base64d | length) >= 16
  and (.data.CLICKHOUSE_V2_READER_PASSWORD | @base64d | length) >= 16
' "$EVIDENCE_DIR/asklake-realtime-runtime-secret.json" >/dev/null \
  || fail "ClickHouse V2 FastAPI credentials do not meet the minimum length contract"

jq -s -e '
  .[0] as $clickhouse
  | .[1] as $backend
  | ($clickhouse.data.materializerPassword == $backend.data.CLICKHOUSE_V2_MATERIALIZER_PASSWORD)
  and ($clickhouse.data.readerPassword == $backend.data.CLICKHOUSE_V2_READER_PASSWORD)
  and ($clickhouse.data["ca.crt"] == $backend.data["clickhouse-v2-ca.crt"])
' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  "$EVIDENCE_DIR/asklake-realtime-runtime-secret.json" >/dev/null \
  || fail "FastAPI/worker ClickHouse credentials or CA differ from the server contract"

jq -s -e '
  .[0] as $clickhouse
  | .[1] as $connect
  | ($connect.data["asklake-clickhouse-v2.properties"] | @base64d) as $properties
  | ($properties | capture("(?m)^clickhouse\\.ingest\\.password=(?<password>[^\\r\\n]+)\\r?$").password)
      == ($clickhouse.data.ingestPassword | @base64d)
  and ($connect.data["clickhouse-v2-ca.crt"] == $clickhouse.data["ca.crt"])
' \
  "$EVIDENCE_DIR/asklake-clickhouse-v2-config-secret.json" \
  "$EVIDENCE_DIR/asklake-kafka-connect-v2-runtime-secret.json" >/dev/null \
  || fail "Kafka Connect ingest credential or CA differs from the ClickHouse server contract"

echo "EKS ClickHouse V2 ExternalSecret, target key, TLS chain/SAN, and credential length preflight passed."
