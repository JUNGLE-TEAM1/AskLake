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


def build_raw_sink_config(
    *,
    topic: str,
    table: str,
    dlq_topic: str,
    database: str = "asklake_realtime_v2",
) -> dict[str, str]:
    if not _TOPIC.fullmatch(topic) or not _TOPIC.fullmatch(dlq_topic):
        raise ValueError("topic and dlq_topic must be safe Kafka topic names")
    if topic == dlq_topic:
        raise ValueError("DLQ topic must differ from the source topic")
    if not _IDENTIFIER.fullmatch(table) or not _IDENTIFIER.fullmatch(database):
        raise ValueError("database and table must be safe ClickHouse identifiers")
    return {
        "connector.class": CONNECTOR_CLASS,
        "tasks.max": "2",
        "topics": topic,
        "hostname": "clickhouse-v2",
        "port": "8443",
        "database": database,
        "username": "asklake_v2_ingest",
        "password": "${file:/run/secrets/asklake-clickhouse-v2.properties:clickhouse.ingest.password}",
        "ssl": "true",
        "sslrootcert": "/run/secrets/clickhouse-v2-ca.crt",
        "ssl_socket_sni": "clickhouse-v2",
        "exactlyOnce": "true",
        "zkPath": "/asklake/realtime-v2/connect-state",
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
        "errors.deadletterqueue.context.headers.enable": "true",
        "errors.log.enable": "true",
        "errors.log.include.messages": "false",
        "consumer.override.isolation.level": "read_committed",
        "consumer.override.enable.auto.commit": "false",
        "consumer.override.auto.offset.reset": "earliest",
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
    ) -> None:
        self.settings = runtime_settings or settings
        if not self.settings.kafka_connect_url:
            raise KafkaConnectError("Kafka Connect URL is not configured")
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
                f"/connectors/{self.settings.kafka_connect_connector_name}/status"
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
            f"/connectors/{self.settings.kafka_connect_connector_name}/config",
            json=config,
        )

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
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
    if not config.get("errors.deadletterqueue.topic.name"):
        raise ValueError("connector DLQ must be configured")
