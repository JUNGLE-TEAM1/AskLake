# syntax=docker/dockerfile:1.7

# Confluent Platform's canonical Kafka Connect worker. The multi-architecture
# manifest digest was verified from Docker Hub on 2026-07-18.
FROM confluentinc/cp-kafka-connect:8.2.2@sha256:8a29608d5b87fd1858e0e7307f98dc9ed43685541c3dc89358f71e80b348ebf9

LABEL org.opencontainers.image.source="https://github.com/ClickHouse/clickhouse-kafka-connect" \
      org.opencontainers.image.version="1.4.0" \
      org.opencontainers.image.description="AskLake Kafka Connect worker with the official ClickHouse sink"

# GitHub release v1.4.0, asset clickhouse-kafka-connect-v1.4.0.zip.
# Docker verifies the published release checksum before the layer is created.
ADD --checksum=sha256:e146cf1205c3a15630fcdf667556da931cb3269e63b1f3f3bedf7dfd1ffc2cb0 \
    https://github.com/ClickHouse/clickhouse-kafka-connect/releases/download/v1.4.0/clickhouse-kafka-connect-v1.4.0.zip \
    /tmp/clickhouse-kafka-connect-v1.4.0.zip

# AWS's Kafka Connect guidance requires the IAM auth uber JAR on the worker
# classpath and outside CONNECT_PLUGIN_PATH to avoid PluginClassLoader splits.
ADD --checksum=sha256:de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c08 \
    https://github.com/aws/aws-msk-iam-auth/releases/download/v2.3.6/aws-msk-iam-auth-2.3.6-all.jar \
    /usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar

ENV CLASSPATH=/usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar

USER root
RUN chmod 0444 /usr/share/java/cp-base-new/aws-msk-iam-auth-2.3.6-all.jar \
    && confluent-hub install --no-prompt /tmp/clickhouse-kafka-connect-v1.4.0.zip \
    && rm -f /tmp/clickhouse-kafka-connect-v1.4.0.zip \
    && mv /etc/confluent/docker/ensure /etc/confluent/docker/ensure.upstream

COPY --chown=0:0 --chmod=0755 entrypoint.sh /usr/local/bin/asklake-kafka-connect-v2-entrypoint.sh
COPY --chown=0:0 --chmod=0755 ensure.sh /etc/confluent/docker/ensure

# The wrapper starts as root only long enough to copy root-readable bind mounts
# into tmpfs. It then execs the canonical worker as numeric appuser 1000:1000.
USER root
ENTRYPOINT ["/usr/local/bin/asklake-kafka-connect-v2-entrypoint.sh"]
CMD ["/etc/confluent/docker/run"]
