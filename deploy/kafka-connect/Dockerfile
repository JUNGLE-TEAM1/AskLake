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

# AWS MSK IAM auth 2.3.6 all-dependencies artifact. The checksum is published
# beside the primary Maven Central artifact and keeps the EKS Kafka Connect
# image independent from node-local credential files.
ADD --checksum=sha256:de63517a6275b4f112c0375f9246b2a78e8ad1a8fe88b1d096244bfc11981c083 \
    https://repo1.maven.org/maven2/software/amazon/msk/aws-msk-iam-auth/2.3.6/aws-msk-iam-auth-2.3.6-all.jar \
    /usr/share/java/kafka/aws-msk-iam-auth-2.3.6-all.jar

USER root
RUN confluent-hub install --no-prompt /tmp/clickhouse-kafka-connect-v1.4.0.zip \
    && test -s /usr/share/java/kafka/aws-msk-iam-auth-2.3.6-all.jar \
    && rm -f /tmp/clickhouse-kafka-connect-v1.4.0.zip

COPY --chown=0:0 --chmod=0755 entrypoint.sh /usr/local/bin/asklake-kafka-connect-v2-entrypoint.sh

# The wrapper starts as root only long enough to copy root-readable bind mounts
# into tmpfs. It then execs the canonical worker as numeric appuser 1000:1000.
USER root
ENTRYPOINT ["/usr/local/bin/asklake-kafka-connect-v2-entrypoint.sh"]
CMD ["/etc/confluent/docker/run"]
