#!/usr/bin/env bash
set -euo pipefail

readonly CLICKHOUSE_V2_TLS_SOURCE_DIR="/run/asklake-secrets-source/clickhouse-v2"
readonly CLICKHOUSE_V2_TLS_STAGING_DIR="/run/asklake-clickhouse-v2-secrets"
readonly CLICKHOUSE_V2_RUNTIME_UID="101"
readonly CLICKHOUSE_V2_RUNTIME_GID="101"

stage_clickhouse_v2_tls() {
  if [[ "${CLICKHOUSE_V2_TLS_STAGING_REQUIRED:-false}" != "true" ]]; then
    return
  fi

  if [[ "$(id -u)" != "0" ]]; then
    echo "ClickHouse V2 TLS staging requires root bootstrap" >&2
    return 1
  fi
  if [[ "$(id -u clickhouse)" != "${CLICKHOUSE_V2_RUNTIME_UID}" \
    || "$(id -g clickhouse)" != "${CLICKHOUSE_V2_RUNTIME_GID}" ]]; then
    echo "ClickHouse V2 runtime UID/GID differs from the pinned image contract" >&2
    return 1
  fi

  install -d \
    -o "${CLICKHOUSE_V2_RUNTIME_UID}" \
    -g "${CLICKHOUSE_V2_RUNTIME_GID}" \
    -m 0700 \
    "${CLICKHOUSE_V2_TLS_STAGING_DIR}"

  local secret_name source_file staged_file
  for secret_name in server.crt server.key ca.crt; do
    source_file="${CLICKHOUSE_V2_TLS_SOURCE_DIR}/${secret_name}"
    staged_file="${CLICKHOUSE_V2_TLS_STAGING_DIR}/${secret_name}"
    if [[ ! -f "${source_file}" || -L "${source_file}" ]]; then
      echo "ClickHouse V2 TLS source is missing or is not a regular file" >&2
      return 1
    fi
    install \
      -o "${CLICKHOUSE_V2_RUNTIME_UID}" \
      -g "${CLICKHOUSE_V2_RUNTIME_GID}" \
      -m 0400 \
      "${source_file}" \
      "${staged_file}"
    if [[ "$(stat -c '%u:%g:%a' "${staged_file}")" != "101:101:400" ]]; then
      echo "ClickHouse V2 TLS staging ownership or mode is invalid" >&2
      return 1
    fi
  done
}

main() {
  stage_clickhouse_v2_tls

# The official entrypoint needs tcp_port during its localhost-only bootstrap.
# Remove only AskLake's generated final-server override before every start.
  rm -f -- /etc/clickhouse-server/config.d/zz-asklake-disable-plaintext.xml
  install -m 0644 \
    /opt/asklake-clickhouse-v2-initdb/01-access-control.sh \
    /docker-entrypoint-initdb.d/01-access-control.sh
  install -m 0644 \
    /opt/asklake-clickhouse-v2-initdb/99-disable-plaintext.sh \
    /docker-entrypoint-initdb.d/99-disable-plaintext.sh

  # The pinned official entrypoint starts its bootstrap server and final server
  # through `clickhouse su 101:101`; do not replace that privilege drop here.
  exec /entrypoint.sh "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
