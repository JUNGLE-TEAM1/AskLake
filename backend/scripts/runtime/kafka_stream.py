"""Kafka Structured Streaming source construction."""

from __future__ import annotations

from typing import Any, Mapping

from runtime.config import KafkaWorkerConfig, kafka_security_options


def load_kafka_stream(
    spark: Any,
    config: KafkaWorkerConfig,
    environ: Mapping[str, str],
):
    reader = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", config.broker)
        .option("subscribe", config.topic)
        .option("startingOffsets", environ.get("ASKLAKE_CONTINUOUS_OFFSET_POLICY", "earliest"))
        .option("maxOffsetsPerTrigger", environ.get("ASKLAKE_CONTINUOUS_MAX_OFFSETS", "100"))
        .option("kafka.group.id", config.consumer_group_id)
    )
    for option_name, option_value in kafka_security_options(config.auth_mode).items():
        reader = reader.option(option_name, option_value)
    return reader.load()
