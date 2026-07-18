#!/usr/bin/env bash
set -euo pipefail

readonly KAFKA_CONNECT_SECRET_SOURCE_DIR="/run/asklake-secrets-source/kafka-connect"
readonly KAFKA_CONNECT_SECRET_STAGING_DIR="/run/secrets"
readonly KAFKA_CONNECT_RUNTIME_UID="1000"
readonly KAFKA_CONNECT_RUNTIME_GID="1000"

stage_kafka_connect_secrets() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "Kafka Connect secret staging requires root bootstrap" >&2
    return 1
  fi
  if [[ "$(id -u appuser)" != "${KAFKA_CONNECT_RUNTIME_UID}" \
    || "$(id -g appuser)" != "${KAFKA_CONNECT_RUNTIME_GID}" ]]; then
    echo "Kafka Connect runtime UID/GID differs from the pinned image contract" >&2
    return 1
  fi

  install -d \
    -o "${KAFKA_CONNECT_RUNTIME_UID}" \
    -g "${KAFKA_CONNECT_RUNTIME_GID}" \
    -m 0700 \
    "${KAFKA_CONNECT_SECRET_STAGING_DIR}"

  stage_kafka_connect_secret \
    "asklake-clickhouse-v2.properties" \
    "asklake-clickhouse-v2.properties"

  if [[ "${KAFKA_CONNECT_V2_TLS_CA_STAGING_REQUIRED:-false}" == "true" ]]; then
    stage_kafka_connect_secret \
      "clickhouse-v2-ca.crt" \
      "clickhouse-v2-ca.crt"
  fi
}

stage_kafka_connect_secret() {
  local source_name="$1"
  local staged_name="$2"
  local source_file="${KAFKA_CONNECT_SECRET_SOURCE_DIR}/${source_name}"
  local staged_file="${KAFKA_CONNECT_SECRET_STAGING_DIR}/${staged_name}"

  if [[ ! -f "${source_file}" || -L "${source_file}" ]]; then
    echo "Kafka Connect secret source is missing or is not a regular file" >&2
    return 1
  fi
  install \
    -o "${KAFKA_CONNECT_RUNTIME_UID}" \
    -g "${KAFKA_CONNECT_RUNTIME_GID}" \
    -m 0400 \
    "${source_file}" \
    "${staged_file}"
  if [[ "$(stat -c '%u:%g:%a' "${staged_file}")" != "1000:1000:400" ]]; then
    echo "Kafka Connect secret staging ownership or mode is invalid" >&2
    return 1
  fi
}

main() {
  stage_kafka_connect_secrets

  if (( $# == 0 )); then
    set -- /etc/confluent/docker/run
  fi

  exec /usr/sbin/chroot \
    --userspec="${KAFKA_CONNECT_RUNTIME_UID}:${KAFKA_CONNECT_RUNTIME_GID}" \
    / \
    "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
