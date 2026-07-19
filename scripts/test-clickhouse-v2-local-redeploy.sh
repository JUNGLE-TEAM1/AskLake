#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ASKLAKE_CLICKHOUSE_V2_TEST_IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
  echo 'ASKLAKE_CLICKHOUSE_V2_TEST_IMAGE must be an immutable local image reference' >&2
  exit 2
fi
[[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || {
  echo 'ClickHouse V2 test image must use an immutable digest' >&2
  exit 2
}
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo 'ClickHouse V2 test image is not present locally; this test never pulls implicitly' >&2
  exit 2
}

suffix="$(date +%s)-$$"
network="asklake-v2-contract-$suffix"
keeper_container="asklake-v2-keeper-$suffix"
server_container="asklake-v2-server-$suffix"
keeper_volume="asklake-v2-keeper-data-$suffix"
server_volume="asklake-v2-server-data-$suffix"
temp_dir="$(mktemp -d)"

cleanup() {
  docker container rm -f "$server_container" "$keeper_container" >/dev/null 2>&1 || true
  docker volume rm "$server_volume" "$keeper_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

mkdir -p "$temp_dir/config" "$temp_dir/keeper" "$temp_dir/tls-source"
cp "$ROOT_DIR/deploy/clickhouse-v2/config.d/tls.xml" "$temp_dir/config/tls.xml"
cp "$ROOT_DIR/deploy/clickhouse-v2/config.d/keeper.xml" "$temp_dir/config/keeper.xml"
cp "$ROOT_DIR/deploy/clickhouse-v2/keeper-config.xml" "$temp_dir/keeper/keeper.xml"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=asklake-v2-local-test-ca' \
  -keyout "$temp_dir/ca.key" -out "$temp_dir/tls-source/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj '/CN=clickhouse-v2' \
  -addext 'subjectAltName=DNS:clickhouse-v2' \
  -keyout "$temp_dir/tls-source/server.key" -out "$temp_dir/server.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$temp_dir/server.csr" \
  -CA "$temp_dir/tls-source/ca.crt" -CAkey "$temp_dir/ca.key" -CAcreateserial \
  -copy_extensions copy -out "$temp_dir/tls-source/server.crt" >/dev/null 2>&1
chmod 400 "$temp_dir/tls-source/server.key"

admin_fixture='local-admin-fixture-value-01'
ingest_fixture='local-ingest-fixture-value-02'
materializer_fixture='local-materializer-fixture-value-03'
migration_fixture='local-migration-fixture-value-04'
observer_fixture='local-observer-fixture-value-05'
reader_fixture='local-reader-fixture-value-06'

docker network create "$network" >/dev/null
docker volume create "$keeper_volume" >/dev/null
docker volume create "$server_volume" >/dev/null

docker run -d --platform linux/amd64 --name "$keeper_container" \
  --network "$network" --network-alias clickhouse-keeper-v2 \
  --mount "type=volume,src=$keeper_volume,dst=/var/lib/clickhouse-keeper" \
  --mount "type=bind,src=$temp_dir/keeper/keeper.xml,dst=/etc/asklake/keeper/keeper.xml,readonly" \
  --entrypoint clickhouse-keeper "$IMAGE" \
  --config-file=/etc/asklake/keeper/keeper.xml >/dev/null

keeper_ready=false
for _ in $(seq 1 60); do
  if docker exec "$keeper_container" clickhouse keeper-client \
    --host 127.0.0.1 --port 9181 --query ruok 2>/dev/null | grep -q imok; then
    keeper_ready=true
    break
  fi
  sleep 1
done
[[ "$keeper_ready" == true ]] || {
  docker logs "$keeper_container" >&2
  echo 'local Keeper did not become ready' >&2
  exit 1
}

start_server() {
  docker run -d --platform linux/amd64 --name "$server_container" \
    --network "$network" --network-alias clickhouse-v2 \
    --mount "type=volume,src=$server_volume,dst=/var/lib/clickhouse" \
    --mount "type=bind,src=$temp_dir/config,dst=/etc/clickhouse-server/config.d/asklake,readonly" \
    --mount "type=bind,src=$temp_dir/tls-source,dst=/run/asklake-secrets-source/clickhouse-v2,readonly" \
    --tmpfs /run/asklake-clickhouse-v2-secrets:rw,noexec,nosuid,size=16m \
    -e CLICKHOUSE_DB=asklake_realtime_v2 \
    -e CLICKHOUSE_USER=asklake_admin \
    -e CLICKHOUSE_PASSWORD="$admin_fixture" \
    -e CLICKHOUSE_V2_INGEST_PASSWORD="$ingest_fixture" \
    -e CLICKHOUSE_V2_MATERIALIZER_PASSWORD="$materializer_fixture" \
    -e CLICKHOUSE_V2_MIGRATION_PASSWORD="$migration_fixture" \
    -e CLICKHOUSE_V2_OBSERVER_PASSWORD="$observer_fixture" \
    -e CLICKHOUSE_V2_READER_PASSWORD="$reader_fixture" \
    -e CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1 \
    -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    -e CLICKHOUSE_V2_DISABLE_PLAINTEXT_AFTER_INIT=true \
    -e CLICKHOUSE_V2_TLS_STAGING_REQUIRED=true \
    "$IMAGE" >/dev/null
}

wait_for_server() {
  local ready=false
  for _ in $(seq 1 120); do
    if docker exec "$server_container" sh -c \
      'clickhouse-client --host clickhouse-v2 --secure --port 9440 --user asklake_v2_reader --password "$CLICKHOUSE_V2_READER_PASSWORD" --query "SELECT 1" >/dev/null' \
      2>/dev/null; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || {
    docker logs "$server_container" >&2
    echo 'local ClickHouse V2 did not become ready' >&2
    exit 1
  }
}

start_server
wait_for_server
docker exec "$server_container" sh -c \
  'clickhouse-client --host clickhouse-v2 --secure --port 9440 --user asklake_admin --password "$CLICKHOUSE_PASSWORD" --multiquery --query "CREATE TABLE IF NOT EXISTS asklake_realtime_v2.redeploy_probe (id UInt8) ENGINE=MergeTree ORDER BY id; TRUNCATE TABLE asklake_realtime_v2.redeploy_probe; INSERT INTO asklake_realtime_v2.redeploy_probe VALUES (1);"'
test "$(docker exec "$server_container" sh -c \
  'clickhouse-client --host clickhouse-v2 --secure --port 9440 --user asklake_v2_reader --password "$CLICKHOUSE_V2_READER_PASSWORD" --query "SELECT count() FROM asklake_realtime_v2.redeploy_probe"')" = 1

docker container rm -f "$server_container" >/dev/null
start_server
wait_for_server
test "$(docker exec "$server_container" sh -c \
  'clickhouse-client --host clickhouse-v2 --secure --port 9440 --user asklake_v2_reader --password "$CLICKHOUSE_V2_READER_PASSWORD" --query "SELECT count() FROM asklake_realtime_v2.redeploy_probe"')" = 1

echo 'ClickHouse V2 empty-volume init and same-volume redeploy persistence test passed.'
