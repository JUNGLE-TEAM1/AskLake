#!/usr/bin/env bash

# This runs after the loopback-only bootstrap server is ready. The official
# entrypoint stops that server and starts the final process, which rereads this
# fail-closed override. The wrapper deletes it before the next bootstrap.
if [[ "${CLICKHOUSE_V2_DISABLE_PLAINTEXT_AFTER_INIT:-false}" == "true" ]]; then
  cat > /etc/clickhouse-server/config.d/zz-asklake-disable-plaintext.xml <<'XML'
<clickhouse>
    <tcp_port remove="remove"/>
    <interserver_http_port remove="remove"/>
    <mysql_port remove="remove"/>
    <postgresql_port remove="remove"/>
    <grpc_port remove="remove"/>
</clickhouse>
XML
fi
