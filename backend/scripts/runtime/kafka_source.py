"""Kafka source reader options shared by Continuous Spark runtimes."""

from typing import Any


def configure_kafka_auth(source_reader: Any, auth_mode: str) -> Any:
    """Apply image-local MSK IAM options without widening non-IAM readers."""

    if auth_mode.strip().lower() != "iam":
        return source_reader
    return (
        source_reader.option("kafka.security.protocol", "SASL_SSL")
        .option("kafka.sasl.mechanism", "AWS_MSK_IAM")
        .option(
            "kafka.sasl.jaas.config",
            "software.amazon.msk.auth.iam.IAMLoginModule required;",
        )
        .option(
            "kafka.sasl.client.callback.handler.class",
            "software.amazon.msk.auth.iam.IAMClientCallbackHandler",
        )
    )
