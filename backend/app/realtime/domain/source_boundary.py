from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Iterable


@dataclass(frozen=True, order=True)
class PartitionBoundary:
    topic: str
    partition: int
    from_offset_exclusive: int
    to_offset_inclusive: int

    def __post_init__(self) -> None:
        if not self.topic.strip() or self.partition < 0:
            raise ValueError("source boundary topic and partition are invalid")
        if self.from_offset_exclusive < -1:
            raise ValueError("source boundary cannot start below offset -1")
        if self.to_offset_inclusive <= self.from_offset_exclusive:
            raise ValueError("source boundary must contain at least one offset")

    def document(self) -> dict[str, object]:
        return {
            "topic": self.topic,
            "partition": self.partition,
            "fromOffsetExclusive": self.from_offset_exclusive,
            "toOffsetInclusive": self.to_offset_inclusive,
        }


@dataclass(frozen=True)
class SourceBoundary:
    partitions: tuple[PartitionBoundary, ...]

    @classmethod
    def build(cls, partitions: Iterable[PartitionBoundary]) -> SourceBoundary:
        ordered = tuple(sorted(partitions))
        identities = [(item.topic, item.partition) for item in ordered]
        if not ordered or len(identities) != len(set(identities)):
            raise ValueError("source boundary requires unique non-empty partitions")
        return cls(ordered)

    def document(self) -> dict[str, object]:
        return {"partitions": [item.document() for item in self.partitions]}

    def canonical_json(self) -> str:
        return json.dumps(self.document(), sort_keys=True, separators=(",", ":"))

    def fingerprint(self, pipeline_version_id: str) -> str:
        if not pipeline_version_id.strip():
            raise ValueError("pipeline version is required")
        material = [pipeline_version_id]
        material.extend(
            f"{item.topic}|{item.partition}|{item.from_offset_exclusive}|{item.to_offset_inclusive}"
            for item in self.partitions
        )
        return hashlib.sha256("|".join(material).encode("utf-8")).hexdigest()

    def materialization_id(self, pipeline_version_id: str) -> str:
        digest = hashlib.sha256(
            f"materialization|{pipeline_version_id}|{self.fingerprint(pipeline_version_id)}".encode("utf-8")
        ).hexdigest()
        return f"rtm_{digest}"


def serving_key(
    *,
    scope_id: str,
    dataset_id: str,
    pipeline_version_id: str,
    business_key_values: Iterable[object],
) -> str:
    values = json.dumps(
        list(business_key_values),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(
        f"{scope_id}|{dataset_id}|{pipeline_version_id}|{values}".encode("utf-8")
    ).hexdigest()


def serving_row_version(*, pipeline_generation: int, correction_generation: int) -> int:
    if not 0 < pipeline_generation < 2**32:
        raise ValueError("pipeline generation must fit an unsigned 32-bit value")
    if not 0 <= correction_generation < 2**32:
        raise ValueError("correction generation must fit an unsigned 32-bit value")
    return (pipeline_generation << 32) | correction_generation
