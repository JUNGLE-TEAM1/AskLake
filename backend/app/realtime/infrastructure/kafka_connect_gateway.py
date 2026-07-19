from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any

import httpx

from app.core.config import Settings, settings


CONNECTOR_CLASS = "com.clickhouse.kafka.connect.ClickHouseSinkConnector"
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TOPIC = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,248}$")
_CONNECTOR_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_KEEPER_PATH = re.compile(r"^/[A-Za-z0-9._/-]{1,240}$")


class KafkaConnectError(RuntimeError):
    pass


@dataclass(frozen=True)
class ConnectorProbe:
    worker_ready: bool
    registered: bool
    connector_state: str
    task_states: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return (
            self.worker_ready
            and self.registered
            and self.connector_state == "RUNNING"
            and bool(self.task_states)
            and all(state == "RUNNING" for state in self.task_states)
        )

    @property
    def runtime_ready(self) -> bool:
        """The worker can accept connectors even when no Job exists yet."""

        return self.worker_ready


def build_raw_sink_config(
    *,
    topic: str,
    table: str,
    dlq_topic: str,
    consumer_group: str,
    database: str = "asklake_realtime_v2",
    state_path: str = "/asklake/realtime-v2/connect-state",
) -> dict[str, str]:
    if not _TOPIC.fullmatch(topic) or not _TOPIC.fullmatch(dlq_topic):
        raise ValueError("topic and dlq_topic must be safe Kafka topic names")
    if topic == dlq_topic:
        raise ValueError("DLQ topic must differ from the source topic")
    if not _CONNECTOR_NAME.fullmatch(consumer_group):
        raise ValueError("consumer_group must be a safe exact Kafka group")
    if not _IDENTIFIER.fullmatch(table) or not _IDENTIFIER.fullmatch(database):
        raise ValueError("database and table must be safe ClickHouse identifiers")
    if not _KEEPER_PATH.fullmatch(state_path) or "//" in state_path or ".." in state_path:
        raise ValueError("state_path must be a safe dedicated Keeper path")
    return {
        "connector.class": CONNECTOR_CLASS,
        # The isolated MVP has one Connect worker and one sink task. A single
        # task can own every partition while keeping the 2 GiB canary budget
        # deterministic; production parallelism remains a separate HA gate.
        "tasks.max": "1",
        "topics": topic,
        "hostname": "clickhouse-v2",
        "port": "8443",
        "database": database,
        "username": "asklake_v2_ingest",
        "password": "${file:/run/secrets/asklake-clickhouse-v2.properties:clickhouse.ingest.password}",
        "ssl": "true",
        "jdbcConnectionProperties": "?ssl=true&sslmode=strict",
        "exactlyOnce": "true",
        "zkPath": state_path,
        "zkDatabase": "connect_state",
        "topic2TableMap": f"{topic}={table}",
        "key.converter": "org.apache.kafka.connect.storage.StringConverter",
        "value.converter": "org.apache.kafka.connect.storage.StringConverter",
        "transforms": "hoistPayload,insertMetadata",
        "transforms.hoistPayload.type": "org.apache.kafka.connect.transforms.HoistField$Value",
        "transforms.hoistPayload.field": "payload",
        "transforms.insertMetadata.type": "org.apache.kafka.connect.transforms.InsertField$Value",
        "transforms.insertMetadata.topic.field": "kafka_topic",
        "transforms.insertMetadata.partition.field": "kafka_partition",
        "transforms.insertMetadata.offset.field": "kafka_offset",
        "transforms.insertMetadata.timestamp.field": "kafka_timestamp",
        "errors.tolerance": "all",
        "errors.deadletterqueue.topic.name": dlq_topic,
        "errors.deadletterqueue.topic.replication.factor": "1",
        "errors.deadletterqueue.context.headers.enable": "true",
        "errors.log.enable": "true",
        "errors.log.include.messages": "false",
        "consumer.override.isolation.level": "read_committed",
        "consumer.override.enable.auto.commit": "false",
        "consumer.override.auto.offset.reset": "earliest",
        "consumer.override.group.id": consumer_group,
        "consumer.override.security.protocol": "SASL_SSL",
        "consumer.override.sasl.mechanism": "AWS_MSK_IAM",
        "consumer.override.sasl.jaas.config": "software.amazon.msk.auth.iam.IAMLoginModule required;",
        "consumer.override.sasl.client.callback.handler.class": "software.amazon.msk.auth.iam.IAMClientCallbackHandler",
        "producer.override.security.protocol": "SASL_SSL",
        "producer.override.sasl.mechanism": "AWS_MSK_IAM",
        "producer.override.sasl.jaas.config": "software.amazon.msk.auth.iam.IAMLoginModule required;",
        "producer.override.sasl.client.callback.handler.class": "software.amazon.msk.auth.iam.IAMClientCallbackHandler",
        "admin.override.security.protocol": "SASL_SSL",
        "admin.override.sasl.mechanism": "AWS_MSK_IAM",
        "admin.override.sasl.jaas.config": "software.amazon.msk.auth.iam.IAMLoginModule required;",
        "admin.override.sasl.client.callback.handler.class": "software.amazon.msk.auth.iam.IAMClientCallbackHandler",
    }


def connector_config_fingerprint(config: dict[str, str]) -> str:
    redacted = {key: value for key, value in config.items() if key != "password"}
    payload = json.dumps(redacted, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class KafkaConnectGateway:
    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        connector_name: str | None = None,
    ) -> None:
        self.settings = runtime_settings or settings
        if not self.settings.kafka_connect_url:
            raise KafkaConnectError("Kafka Connect URL is not configured")
        self.connector_name = str(
            connector_name or self.settings.kafka_connect_connector_name
        ).strip()
        if not _CONNECTOR_NAME.fullmatch(self.connector_name):
            raise KafkaConnectError("Kafka Connect connector name is invalid")
        self._client = httpx.Client(
            base_url=self.settings.kafka_connect_url.rstrip("/"),
            timeout=self.settings.kafka_connect_request_timeout_seconds,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def probe(self) -> ConnectorProbe:
        try:
            plugins = self._request("GET", "/connector-plugins")
            worker_ready = isinstance(plugins, list) and any(
                isinstance(item, dict) and item.get("class") == CONNECTOR_CLASS
                for item in plugins
            )
            response = self._client.get(
                f"/connectors/{self.connector_name}/status"
            )
            if response.status_code == 404:
                return ConnectorProbe(worker_ready, False, "UNREGISTERED", ())
            response.raise_for_status()
            status_payload = response.json()
            connector_state = str((status_payload.get("connector") or {}).get("state") or "UNKNOWN")
            task_states = tuple(str(item.get("state") or "UNKNOWN") for item in status_payload.get("tasks") or [] if isinstance(item, dict))
            return ConnectorProbe(worker_ready, True, connector_state, task_states)
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise KafkaConnectError("Kafka Connect readiness probe failed") from exc

    def put_connector(self, config: dict[str, str]) -> dict[str, Any]:
        _validate_raw_sink_config(config)
        return self._request(
            "PUT",
            f"/connectors/{self.connector_name}/config",
            json=config,
        )

    def pause_connector(self) -> None:
        self._request_without_json("PUT", f"/connectors/{self.connector_name}/pause")

    def resume_connector(self) -> None:
        self._request_without_json("PUT", f"/connectors/{self.connector_name}/resume")

    def restart_failed(self) -> None:
        self._request_without_json(
            "POST",
            f"/connectors/{self.connector_name}/restart",
            params={"includeTasks": "true", "onlyFailed": "true"},
        )

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise KafkaConnectError("Kafka Connect request failed") from exc

    def _request_without_json(self, method: str, path: str, **kwargs: Any) -> None:
        try:
            response = self._client.request(method, path, **kwargs)
            if response.status_code not in {202, 204}:
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise KafkaConnectError("Kafka Connect request failed") from exc


def _validate_raw_sink_config(config: dict[str, str]) -> None:
    required = {
        "connector.class": CONNECTOR_CLASS,
        "exactlyOnce": "true",
        "value.converter": "org.apache.kafka.connect.storage.StringConverter",
        "errors.tolerance": "all",
        "errors.deadletterqueue.context.headers.enable": "true",
        "consumer.override.isolation.level": "read_committed",
    }
    if any(config.get(key) != value for key, value in required.items()):
        raise ValueError("connector config violates the raw ingest safety contract")
    password = config.get("password", "")
    if not password.startswith("${file:") or "clickhouse.ingest.password" not in password:
        raise ValueError("connector password must use FileConfigProvider")
    if config.get("jdbcConnectionProperties") != "?ssl=true&sslmode=strict":
        raise ValueError("connector must enforce strict ClickHouse TLS verification")
    for client in ("consumer", "producer", "admin"):
        if (
            config.get(f"{client}.override.security.protocol") != "SASL_SSL"
            or config.get(f"{client}.override.sasl.mechanism") != "AWS_MSK_IAM"
            or config.get(f"{client}.override.sasl.jaas.config")
            != "software.amazon.msk.auth.iam.IAMLoginModule required;"
            or config.get(f"{client}.override.sasl.client.callback.handler.class")
            != "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
        ):
            raise ValueError("connector clients must enforce MSK IAM authentication")
    if not config.get("errors.deadletterqueue.topic.name"):
        raise ValueError("connector DLQ must be configured")
