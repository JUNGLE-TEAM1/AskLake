#!/usr/bin/env bash
set -euo pipefail

. /etc/confluent/docker/bash-config

if [[ "${CONNECT_SASL_MECHANISM:-}" != "AWS_MSK_IAM" ]]; then
  exec /etc/confluent/docker/ensure.upstream "$@"
fi

readonly timeout_seconds="${CONNECT_CUB_KAFKA_TIMEOUT:-40}"
readonly probe_timeout_seconds="${CONNECT_KAFKA_PROBE_TIMEOUT:-15}"
readonly deadline="$((SECONDS + timeout_seconds))"
readonly client_config="/etc/${COMPONENT}/kafka-connect.properties"

if [[ ! -r "${client_config}" ]]; then
  echo "Kafka Connect IAM readiness config is missing" >&2
  exit 1
fi

echo "===> Check if Kafka IAM authentication is healthy ..."
while ! timeout "${probe_timeout_seconds}" kafka-topics \
  --bootstrap-server "${CONNECT_BOOTSTRAP_SERVERS}" \
  --command-config "${client_config}" \
  --list >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "Kafka Connect IAM readiness failed" >&2
    exit 1
  fi
  sleep 2
done
