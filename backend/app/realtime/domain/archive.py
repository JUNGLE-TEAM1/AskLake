from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import hashlib
import json
from typing import Literal, Mapping

from app.realtime.domain.source_boundary import SourceBoundary


EvidenceRole = Literal["hot", "archive"]


def _decimal_text(value: object) -> str:
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("parity numeric sums must contain decimal values") from exc
    if not decimal.is_finite():
        raise ValueError("parity numeric sums must be finite")
    rendered = format(decimal.normalize(), "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return "0" if rendered in {"-0", ""} else rendered


@dataclass(frozen=True)
class ParityEvidence:
    role: EvidenceRole
    dataset_id: str
    pipeline_version_id: str
    binding_version_id: str
    boundary: SourceBoundary
    dimension_version_ids: Mapping[str, str]
    row_count: int
    checksum: str
    distinct_source_position_count: int
    schema_fingerprint: str
    null_count: int
    error_count: int
    numeric_sums: Mapping[str, object]
    sample_hash: str

    def __post_init__(self) -> None:
        identities = (
            self.dataset_id,
            self.pipeline_version_id,
            self.binding_version_id,
            self.checksum,
            self.schema_fingerprint,
            self.sample_hash,
        )
        if self.role not in {"hot", "archive"} or any(not str(item).strip() for item in identities):
            raise ValueError("parity evidence identity is incomplete")
        if any(value < 0 for value in (
            self.row_count,
            self.distinct_source_position_count,
            self.null_count,
            self.error_count,
        )):
            raise ValueError("parity evidence counters cannot be negative")
        dimensions = {str(key): str(value) for key, value in self.dimension_version_ids.items()}
        if any(not key.strip() or not value.strip() for key, value in dimensions.items()):
            raise ValueError("parity dimension version identity is invalid")
        sums = {str(key): _decimal_text(value) for key, value in self.numeric_sums.items()}
        if any(not key.strip() for key in sums):
            raise ValueError("parity numeric sum field is invalid")
        object.__setattr__(self, "dimension_version_ids", dict(sorted(dimensions.items())))
        object.__setattr__(self, "numeric_sums", dict(sorted(sums.items())))

    def document(self) -> dict[str, object]:
        return {
            "role": self.role,
            "datasetId": self.dataset_id,
            "pipelineVersionId": self.pipeline_version_id,
            "bindingVersionId": self.binding_version_id,
            "sourceBoundary": self.boundary.document(),
            "dimensionVersionIds": dict(self.dimension_version_ids),
            "rowCount": self.row_count,
            "checksum": self.checksum,
            "distinctSourcePositionCount": self.distinct_source_position_count,
            "schemaFingerprint": self.schema_fingerprint,
            "nullCount": self.null_count,
            "errorCount": self.error_count,
            "numericSums": dict(self.numeric_sums),
            "sampleHash": self.sample_hash,
        }


@dataclass(frozen=True)
class ArchiveParityReport:
    report_id: str
    hot: ParityEvidence
    archive: ParityEvidence
    mismatch_fields: tuple[str, ...]

    @classmethod
    def compare(
        cls,
        hot: ParityEvidence,
        archive: ParityEvidence,
    ) -> ArchiveParityReport:
        if hot.role != "hot" or archive.role != "archive":
            raise ValueError("parity comparison requires hot and archive evidence")
        comparisons = (
            ("datasetId", hot.dataset_id, archive.dataset_id),
            ("pipelineVersionId", hot.pipeline_version_id, archive.pipeline_version_id),
            ("sourceBoundary", hot.boundary, archive.boundary),
            ("dimensionVersionIds", hot.dimension_version_ids, archive.dimension_version_ids),
            ("rowCount", hot.row_count, archive.row_count),
            ("checksum", hot.checksum, archive.checksum),
            (
                "distinctSourcePositionCount",
                hot.distinct_source_position_count,
                archive.distinct_source_position_count,
            ),
            ("schemaFingerprint", hot.schema_fingerprint, archive.schema_fingerprint),
            ("nullCount", hot.null_count, archive.null_count),
            ("errorCount", hot.error_count, archive.error_count),
            ("numericSums", hot.numeric_sums, archive.numeric_sums),
            ("sampleHash", hot.sample_hash, archive.sample_hash),
        )
        mismatches = tuple(name for name, left, right in comparisons if left != right)
        encoded = json.dumps(
            {"hot": hot.document(), "archive": archive.document()},
            sort_keys=True,
            separators=(",", ":"),
        )
        report_id = "rtpar_" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        return cls(report_id, hot, archive, mismatches)

    @property
    def matched(self) -> bool:
        return not self.mismatch_fields

    @property
    def status(self) -> Literal["matched", "mismatch"]:
        return "matched" if self.matched else "mismatch"


@dataclass(frozen=True)
class RebuildPlan:
    operation_id: str
    idempotency_key: str
    dataset_id: str
    pipeline_version_id: str
    shadow_binding_version_id: str
    physical_database: str
    physical_table: str
    parity_report_id: str
    boundary: SourceBoundary
    dimension_version_ids: dict[str, str]
    tail_start_offsets: tuple[dict[str, object], ...]

    @classmethod
    def build(
        cls,
        report: ArchiveParityReport,
        *,
        shadow_binding_version_id: str,
        physical_database: str,
        physical_table: str,
    ) -> RebuildPlan:
        if not report.matched:
            raise ValueError("rebuild requires matched hot/archive parity evidence")
        if any(not value.strip() for value in (
            shadow_binding_version_id,
            physical_database,
            physical_table,
        )):
            raise ValueError("rebuild shadow target is incomplete")
        material = "|".join((
            report.report_id,
            shadow_binding_version_id,
            physical_database,
            physical_table,
        ))
        digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
        boundary = report.archive.boundary
        tail = tuple({
            "topic": partition.topic,
            "partition": partition.partition,
            "nextOffset": partition.to_offset_inclusive + 1,
        } for partition in boundary.partitions)
        return cls(
            operation_id=f"rtrebuild_{digest}",
            idempotency_key=f"rebuild:{digest}",
            dataset_id=report.archive.dataset_id,
            pipeline_version_id=report.archive.pipeline_version_id,
            shadow_binding_version_id=shadow_binding_version_id,
            physical_database=physical_database,
            physical_table=physical_table,
            parity_report_id=report.report_id,
            boundary=boundary,
            dimension_version_ids=dict(report.archive.dimension_version_ids),
            tail_start_offsets=tail,
        )


@dataclass(frozen=True)
class RebuildCompletionEvidence:
    parity_report_id: str
    gap_count: int
    overlap_count: int

    def __post_init__(self) -> None:
        if not self.parity_report_id.strip() or self.gap_count < 0 or self.overlap_count < 0:
            raise ValueError("rebuild completion evidence is invalid")
        if self.gap_count or self.overlap_count:
            raise ValueError("rebuild cannot become ready with source gaps or overlaps")
