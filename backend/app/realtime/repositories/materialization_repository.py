from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.realtime.domain.source_boundary import SourceBoundary


class MaterializationRepository:
    """Two-phase materialization metadata writer; the caller owns transactions."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def reserve(
        self,
        *,
        materialization_id: str,
        pipeline_version_id: str,
        boundary: SourceBoundary,
        source_fingerprint: str,
        dimension_version_ids: dict[str, str],
        clickhouse_query_id: str,
        lease_generation: int,
    ) -> bool:
        result = self.session.execute(text("""
            INSERT INTO realtime_materializations (
                id, pipeline_version_id, source_boundary, source_fingerprint,
                dimension_version_ids, clickhouse_query_id, lease_generation, status
            ) VALUES (
                :id, :pipeline_version_id, CAST(:source_boundary AS JSONB), :source_fingerprint,
                CAST(:dimension_version_ids AS JSONB), :clickhouse_query_id, :lease_generation, 'reserved'
            )
            ON CONFLICT (pipeline_version_id, source_fingerprint) DO UPDATE SET
                retry_count = realtime_materializations.retry_count + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE realtime_materializations.id = EXCLUDED.id
              AND realtime_materializations.clickhouse_query_id = EXCLUDED.clickhouse_query_id
              AND realtime_materializations.lease_generation = EXCLUDED.lease_generation
        """), {
            "id": materialization_id,
            "pipeline_version_id": pipeline_version_id,
            "source_boundary": boundary.canonical_json(),
            "source_fingerprint": source_fingerprint,
            "dimension_version_ids": json.dumps(dimension_version_ids, sort_keys=True, separators=(",", ":")),
            "clickhouse_query_id": clickhouse_query_id,
            "lease_generation": lease_generation,
        })
        return result.rowcount == 1

    def mark_running(self, *, materialization_id: str, lease_generation: int) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_materializations
            SET status = 'running', last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND lease_generation = :lease_generation
              AND status IN ('reserved', 'failed', 'reconciling', 'running', 'materialized')
        """), {"id": materialization_id, "lease_generation": lease_generation})
        return result.rowcount == 1

    def mark_reconciling(self, *, materialization_id: str, lease_generation: int) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_materializations
            SET status = 'reconciling', updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND lease_generation = :lease_generation
              AND status IN ('reserved', 'running', 'failed', 'reconciling')
        """), {"id": materialization_id, "lease_generation": lease_generation})
        return result.rowcount == 1

    def mark_materialized(
        self,
        *,
        materialization_id: str,
        lease_generation: int,
        target_row_count: int,
        target_checksum: str,
    ) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_materializations
            SET status = 'materialized', target_row_count = :row_count,
                target_checksum = :checksum, committed_at = CURRENT_TIMESTAMP,
                last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND lease_generation = :lease_generation
              AND status IN ('reserved', 'running', 'failed', 'reconciling', 'materialized')
        """), {
            "id": materialization_id,
            "lease_generation": lease_generation,
            "row_count": target_row_count,
            "checksum": target_checksum,
        })
        return result.rowcount == 1

    def mark_failed(
        self,
        *,
        materialization_id: str,
        lease_generation: int,
        error_code: str,
    ) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_materializations
            SET status = 'failed', last_error_code = :error_code,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND lease_generation = :lease_generation
              AND status IN ('reserved', 'running', 'reconciling')
        """), {
            "id": materialization_id,
            "lease_generation": lease_generation,
            "error_code": error_code[:120],
        })
        return result.rowcount == 1

    def advance_checkpoints(
        self,
        *,
        pipeline_version_id: str,
        boundary: SourceBoundary,
        lease_generation: int,
    ) -> None:
        for item in boundary.partitions:
            result = self.session.execute(text("""
                UPDATE realtime_partition_checkpoints
                SET last_applied_offset = :to_offset, updated_at = CURRENT_TIMESTAMP
                WHERE pipeline_version_id = :pipeline_version_id
                  AND topic = :topic AND partition = :partition
                  AND last_applied_offset = :from_offset
                  AND last_contiguously_received_offset >= :to_offset
                  AND lease_generation = :lease_generation
            """), {
                "pipeline_version_id": pipeline_version_id,
                "topic": item.topic,
                "partition": item.partition,
                "from_offset": item.from_offset_exclusive,
                "to_offset": item.to_offset_inclusive,
                "lease_generation": lease_generation,
            })
            if result.rowcount != 1:
                raise ValueError(
                    f"stale checkpoint CAS for {item.topic}[{item.partition}]"
                )
