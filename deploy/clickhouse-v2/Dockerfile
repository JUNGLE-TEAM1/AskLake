# syntax=docker/dockerfile:1.7

FROM clickhouse/clickhouse-server:26.3.17.4@sha256:85c434814ac8905e5648027ce926f74ab067edd6aadbccb6c0c165cd3571ea49

COPY --chmod=0755 entrypoint.sh /usr/local/bin/asklake-clickhouse-v2-entrypoint.sh
COPY --chmod=0644 keeper-config.xml /etc/clickhouse-keeper/keeper-config.xml
COPY --chmod=0644 config.d/keeper.xml config.d/tls.xml /etc/clickhouse-server/config.d/
COPY --chmod=0644 client-config.xml /etc/clickhouse-client/config.xml
COPY --chmod=0644 initdb/ /opt/asklake-clickhouse-v2-initdb/

ENTRYPOINT ["/bin/bash", "/usr/local/bin/asklake-clickhouse-v2-entrypoint.sh"]
