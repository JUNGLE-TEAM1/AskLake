from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.realtime.domain.source_boundary import SourceBoundary


MutationType = Literal["append", "upsert", "replace", "retract"]


@dataclass(frozen=True)
class RealtimePublication:
    dataset_id: str
    pipeline_version_id: str
    serving_version_id: str
    materialization_id: str
    source_fingerprint: str
    boundary: SourceBoundary
    dimension_version_ids: dict[str, str]
    lease_generation: int
    binding_epoch: int
    physical_database: str
    physical_table: str
    row_count: int
    checksum: str
    mutation_type: MutationType
    correlation_id: str

    def __post_init__(self) -> None:
        bounded = (
            self.dataset_id, self.pipeline_version_id, self.serving_version_id,
            self.materialization_id, self.source_fingerprint, self.checksum, self.correlation_id,
        )
        if any(not str(item).strip() for item in bounded):
            raise ValueError("realtime publication identity and evidence are required")
        if self.lease_generation < 0 or self.binding_epoch < 0 or self.row_count < 0:
            raise ValueError("realtime publication counters cannot be negative")
        if len(self.source_fingerprint) != 64:
            raise ValueError("realtime publication source fingerprint must be SHA-256")
        if self.mutation_type not in {"append", "upsert", "replace", "retract"}:
            raise ValueError("realtime publication mutation type is invalid")


@dataclass(frozen=True)
class PublicationResult:
    dataset_id: str
    revision: int
    event_cursor: int
    created: bool
