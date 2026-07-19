#!/usr/bin/env bash
set -euo pipefail

readonly KAFKA_CONNECT_SECRET_SOURCE_DIR="/run/asklake-secrets-source/kafka-connect"
readonly KAFKA_CONNECT_SECRET_STAGING_DIR="/run/secrets"
readonly KAFKA_CONNECT_RUNTIME_UID="1000"
readonly KAFKA_CONNECT_RUNTIME_GID="1000"
readonly KAFKA_CONNECT_TRUSTSTORE_PATH="${KAFKA_CONNECT_SECRET_STAGING_DIR}/clickhouse-v2-truststore.p12"
readonly KAFKA_CONNECT_KEYTOOL_BIN="${KAFKA_CONNECT_V2_KEYTOOL_BIN:-keytool}"
# This protects a truststore containing only the public CA certificate. It is
# intentionally not an application credential.
readonly KAFKA_CONNECT_TRUSTSTORE_PASSWORD="changeit"

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
    build_clickhouse_truststore
  fi
}

build_clickhouse_truststore() {
  local ca_file="${KAFKA_CONNECT_SECRET_STAGING_DIR}/clickhouse-v2-ca.crt"
  local java_binary
  local java_home
  local default_truststore

  default_truststore="${KAFKA_CONNECT_DEFAULT_TRUSTSTORE_PATH:-}"
  if [[ -z "${default_truststore}" ]]; then
    java_binary="$(readlink -f "$(command -v java)")"
    java_home="$(dirname "$(dirname "${java_binary}")")"
    default_truststore="${java_home}/lib/security/cacerts"
  fi
  if [[ ! -r "${default_truststore}" ]]; then
    echo "Kafka Connect default JVM truststore is missing" >&2
    return 1
  fi

  rm -f "${KAFKA_CONNECT_TRUSTSTORE_PATH}"
  "${KAFKA_CONNECT_KEYTOOL_BIN}" -importkeystore -noprompt \
    -srckeystore "${default_truststore}" \
    -srcstorepass "${KAFKA_CONNECT_TRUSTSTORE_PASSWORD}" \
    -destkeystore "${KAFKA_CONNECT_TRUSTSTORE_PATH}" \
    -deststoretype PKCS12 \
    -deststorepass "${KAFKA_CONNECT_TRUSTSTORE_PASSWORD}" >/dev/null 2>&1
  "${KAFKA_CONNECT_KEYTOOL_BIN}" -importcert -noprompt \
    -alias asklake-clickhouse-v2-ca \
    -file "${ca_file}" \
    -keystore "${KAFKA_CONNECT_TRUSTSTORE_PATH}" \
    -storetype PKCS12 \
    -storepass "${KAFKA_CONNECT_TRUSTSTORE_PASSWORD}" >/dev/null 2>&1
  chown "${KAFKA_CONNECT_RUNTIME_UID}:${KAFKA_CONNECT_RUNTIME_GID}" \
    "${KAFKA_CONNECT_TRUSTSTORE_PATH}"
  chmod 0400 "${KAFKA_CONNECT_TRUSTSTORE_PATH}"
  if [[ "$(stat -c '%u:%g:%a' "${KAFKA_CONNECT_TRUSTSTORE_PATH}")" != "1000:1000:400" ]]; then
    echo "Kafka Connect truststore ownership or mode is invalid" >&2
    return 1
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

  if [[ "${KAFKA_CONNECT_V2_TLS_CA_STAGING_REQUIRED:-false}" == "true" ]]; then
    export KAFKA_OPTS="${KAFKA_OPTS:-} -Djavax.net.ssl.trustStore=${KAFKA_CONNECT_TRUSTSTORE_PATH} -Djavax.net.ssl.trustStorePassword=${KAFKA_CONNECT_TRUSTSTORE_PASSWORD} -Djavax.net.ssl.trustStoreType=PKCS12"
  fi

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
