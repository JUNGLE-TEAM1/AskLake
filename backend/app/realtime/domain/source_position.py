from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import re


_TOPIC = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,248}$")


@dataclass(frozen=True, order=True)
class SourcePosition:
    topic: str
    partition: int
    offset: int

    def __post_init__(self) -> None:
        if not _TOPIC.fullmatch(self.topic):
            raise ValueError("topic must be a safe Kafka topic name")
        if self.partition < 0 or self.offset < 0:
            raise ValueError("partition and offset must be non-negative")

    def document(self) -> dict[str, object]:
        return {"topic": self.topic, "partition": self.partition, "offset": self.offset}

    def digest(self, *, scope_id: str = "deployment") -> str:
        material = f"{scope_id}|{self.topic}|{self.partition}|{self.offset}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class OpaqueEnvelope:
    position: SourcePosition
    payload: bytes
    kafka_timestamp: datetime | None = None

    @classmethod
    def from_value(
        cls,
        *,
        topic: str,
        partition: int,
        offset: int,
        payload: bytes | str,
        kafka_timestamp: datetime | None = None,
    ) -> "OpaqueEnvelope":
        raw = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("raw payload exceeds the 16 MiB envelope limit")
        timestamp = kafka_timestamp
        if timestamp is not None:
            timestamp = timestamp.replace(tzinfo=timestamp.tzinfo or UTC).astimezone(UTC)
        return cls(SourcePosition(topic, partition, offset), raw, timestamp)

    @property
    def payload_hash(self) -> str:
        return hashlib.sha256(self.payload).hexdigest()

    def canonical_document(self) -> dict[str, object]:
        return {
            **self.position.document(),
            "kafkaTimestamp": self.kafka_timestamp.isoformat() if self.kafka_timestamp else None,
            "payload": self.payload.decode("utf-8", errors="strict"),
            "payloadHash": self.payload_hash,
            "eventKey": self.position.digest(),
        }

    def canonical_json(self) -> str:
        return json.dumps(self.canonical_document(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
