from __future__ import annotations

import json
from typing import Literal
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.realtime.domain.source_position import SourcePosition


class DimensionRepository:
    """Dimension metadata writer. The application owns transaction commit."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def activate(
        self,
        *,
        dimension_version_id: str,
        scope_id: str,
        dataset_id: str,
        row_count: int,
        checksum: str,
    ) -> None:
        self.session.execute(text("""
            SELECT id FROM realtime_dimension_versions
            WHERE scope_id = :scope_id AND dimension_dataset_id = :dataset_id
              AND status = 'active'
            FOR UPDATE
        """), {"scope_id": scope_id, "dataset_id": dataset_id})
        self.session.execute(text("""
            UPDATE realtime_dimension_versions
            SET status = 'retired'
            WHERE scope_id = :scope_id AND dimension_dataset_id = :dataset_id
              AND status = 'active' AND id <> :version_id
        """), {"scope_id": scope_id, "dataset_id": dataset_id, "version_id": dimension_version_id})
        result = self.session.execute(text("""
            UPDATE realtime_dimension_versions
            SET status = 'active', row_count = :row_count, checksum = :checksum,
                validity_checked_at = CURRENT_TIMESTAMP,
                published_at = CURRENT_TIMESTAMP
            WHERE id = :version_id AND scope_id = :scope_id
              AND dimension_dataset_id = :dataset_id
              AND status IN ('draft', 'publishing')
              AND physical_database IS NOT NULL AND physical_table IS NOT NULL
        """), {
            "scope_id": scope_id,
            "dataset_id": dataset_id,
            "version_id": dimension_version_id,
            "row_count": row_count,
            "checksum": checksum,
        })
        if result.rowcount != 1:
            raise ValueError("dimension version is stale or lacks physical evidence")

    def schedule_unmatched(
        self,
        *,
        pipeline_version_id: str,
        serving_key: str,
        position: SourcePosition,
        missing_policy: str,
        dimension_dataset_id: str,
        missing_keys: dict[str, object],
        raw_payload_hash: str,
        next_retry_at,
        correction_generation: int,
    ) -> None:
        source_document = position.document()
        self.session.execute(text("""
            INSERT INTO realtime_unmatched_events (
                serving_key, pipeline_version_id, source_position,
                source_position_hash, missing_policy,
                missing_dimension_dataset_id, missing_dimension_keys,
                raw_payload_hash, dimension_version_ids,
                correction_generation, next_retry_at, status
            ) VALUES (
                :serving_key, :pipeline_version_id, CAST(:source_position AS JSONB),
                :source_position_hash, :missing_policy,
                :dimension_dataset_id, CAST(:missing_keys AS JSONB),
                :raw_payload_hash, CAST('{}' AS JSONB),
                :correction_generation, :next_retry_at, 'pending'
            )
            ON CONFLICT (
                pipeline_version_id, source_position_hash,
                missing_dimension_dataset_id
            ) DO UPDATE SET
                next_retry_at = LEAST(realtime_unmatched_events.next_retry_at, EXCLUDED.next_retry_at),
                retry_count = realtime_unmatched_events.retry_count + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE realtime_unmatched_events.status IN ('pending', 'retrying')
        """), {
            "serving_key": serving_key,
            "pipeline_version_id": pipeline_version_id,
            "source_position": json.dumps(source_document, separators=(",", ":")),
            "source_position_hash": position.digest(),
            "missing_policy": missing_policy,
            "dimension_dataset_id": dimension_dataset_id,
            "missing_keys": json.dumps(missing_keys, sort_keys=True, separators=(",", ":")),
            "raw_payload_hash": raw_payload_hash,
            "correction_generation": correction_generation,
            "next_retry_at": next_retry_at,
        })

    def resolve_unmatched(
        self,
        *,
        pipeline_version_id: str,
        position: SourcePosition,
        dimension_dataset_id: str,
        materialization_id: str,
    ) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_unmatched_events
            SET status = 'resolved', resolved_materialization_id = :materialization_id,
                updated_at = CURRENT_TIMESTAMP
            WHERE pipeline_version_id = :pipeline_version_id
              AND source_position_hash = :source_position_hash
              AND missing_dimension_dataset_id = :dimension_dataset_id
              AND status IN ('pending', 'retrying')
        """), {
            "pipeline_version_id": pipeline_version_id,
            "source_position_hash": position.digest(),
            "dimension_dataset_id": dimension_dataset_id,
            "materialization_id": materialization_id,
        })
        return result.rowcount == 1

    def reschedule_unmatched(
        self,
        *,
        pipeline_version_id: str,
        position: SourcePosition,
        dimension_dataset_id: str,
        next_retry_at,
        correction_generation: int,
    ) -> bool:
        result = self.session.execute(text("""
            UPDATE realtime_unmatched_events
            SET status = 'retrying', next_retry_at = :next_retry_at,
                retry_count = retry_count + 1,
                correction_generation = :correction_generation,
                updated_at = CURRENT_TIMESTAMP
            WHERE pipeline_version_id = :pipeline_version_id
              AND source_position_hash = :source_position_hash
              AND missing_dimension_dataset_id = :dimension_dataset_id
              AND status IN ('pending', 'retrying')
        """), {
            "pipeline_version_id": pipeline_version_id,
            "source_position_hash": position.digest(),
            "dimension_dataset_id": dimension_dataset_id,
            "next_retry_at": next_retry_at,
            "correction_generation": correction_generation,
        })
        return result.rowcount == 1

    def mark_terminal(
        self,
        *,
        pipeline_version_id: str,
        position: SourcePosition,
        dimension_dataset_id: str,
        status: Literal["quarantined", "source_expired"],
    ) -> bool:
        if status not in {"quarantined", "source_expired"}:
            raise ValueError("terminal unmatched status is invalid")
        result = self.session.execute(text("""
            UPDATE realtime_unmatched_events
            SET status = :status, updated_at = CURRENT_TIMESTAMP
            WHERE pipeline_version_id = :pipeline_version_id
              AND source_position_hash = :source_position_hash
              AND missing_dimension_dataset_id = :dimension_dataset_id
              AND status IN ('pending', 'retrying')
        """), {
            "pipeline_version_id": pipeline_version_id,
            "source_position_hash": position.digest(),
            "dimension_dataset_id": dimension_dataset_id,
            "status": status,
        })
        return result.rowcount == 1
