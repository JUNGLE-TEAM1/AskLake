#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.realtime.domain.archive import ArchiveParityReport, ParityEvidence
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary


def _document(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: parity evidence must be a JSON object")
    return payload


def _evidence(path: Path, role: str) -> ParityEvidence:
    payload = _document(path)
    boundary_payload = payload.get("sourceBoundary")
    partitions = boundary_payload.get("partitions") if isinstance(boundary_payload, dict) else None
    if not isinstance(partitions, list):
        raise ValueError(f"{path}: sourceBoundary.partitions is required")
    boundary = SourceBoundary.build(
        PartitionBoundary(
            topic=str(item["topic"]),
            partition=int(item["partition"]),
            from_offset_exclusive=int(item["fromOffsetExclusive"]),
            to_offset_inclusive=int(item["toOffsetInclusive"]),
        )
        for item in partitions
        if isinstance(item, dict)
    )
    return ParityEvidence(
        role=role,  # type: ignore[arg-type]
        dataset_id=str(payload["datasetId"]),
        pipeline_version_id=str(payload["pipelineVersionId"]),
        binding_version_id=str(payload["bindingVersionId"]),
        boundary=boundary,
        dimension_version_ids=dict(payload.get("dimensionVersionIds") or {}),
        row_count=int(payload["rowCount"]),
        checksum=str(payload["checksum"]),
        distinct_source_position_count=int(payload["distinctSourcePositionCount"]),
        schema_fingerprint=str(payload["schemaFingerprint"]),
        null_count=int(payload["nullCount"]),
        error_count=int(payload["errorCount"]),
        numeric_sums=dict(payload.get("numericSums") or {}),
        sample_hash=str(payload["sampleHash"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fail closed unless ClickHouse hot and Gold archive evidence match at one boundary."
    )
    parser.add_argument("--hot", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    report = ArchiveParityReport.compare(
        _evidence(args.hot, "hot"),
        _evidence(args.archive, "archive"),
    )
    print(json.dumps({
        "reportId": report.report_id,
        "status": report.status,
        "mismatchFields": list(report.mismatch_fields),
    }, separators=(",", ":")))
    if not report.matched:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
