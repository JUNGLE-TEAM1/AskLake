from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.realtime.domain.receipt import ReceiptAudit
from app.realtime.domain.source_position import SourcePosition


class ReceiptRepository:
    """PostgreSQL receipt ledger; callers own commit/rollback boundaries."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def save_audit(
        self,
        *,
        pipeline_version_id: str,
        audit: ReceiptAudit,
        expected_previous_contiguous: int,
    ) -> bool:
        verified_at = datetime.now(UTC) if audit.status == "contiguous" else None
        self.session.execute(text("""
            INSERT INTO realtime_partition_receipt_ranges (
                pipeline_version_id, topic, partition,
                from_offset_inclusive, to_offset_inclusive,
                expected_position_count, raw_position_count,
                expected_positions_hash, raw_or_resolved_positions_hash,
                status, verified_at
            ) VALUES (
                :pipeline_version_id, :topic, :partition,
                :from_offset, :to_offset,
                :expected_count, :raw_count,
                :expected_hash, :actual_hash, :status, :verified_at
            )
            ON CONFLICT (
                pipeline_version_id, topic, partition,
                from_offset_inclusive, to_offset_inclusive
            ) DO UPDATE SET
                expected_position_count = EXCLUDED.expected_position_count,
                raw_position_count = EXCLUDED.raw_position_count,
                expected_positions_hash = EXCLUDED.expected_positions_hash,
                raw_or_resolved_positions_hash = EXCLUDED.raw_or_resolved_positions_hash,
                status = EXCLUDED.status,
                verified_at = EXCLUDED.verified_at,
                updated_at = CURRENT_TIMESTAMP
        """), {
            "pipeline_version_id": pipeline_version_id,
            "topic": audit.topic,
            "partition": audit.partition,
            "from_offset": audit.from_offset_inclusive,
            "to_offset": audit.to_offset_inclusive,
            "expected_count": len(audit.expected_offsets),
            "raw_count": len(audit.raw_offsets),
            "expected_hash": audit.expected_positions_hash,
            "actual_hash": audit.raw_or_resolved_positions_hash,
            "status": audit.status,
            "verified_at": verified_at,
        })
        self.session.execute(text("""
            INSERT INTO realtime_partition_checkpoints (
                pipeline_version_id, topic, partition, last_observed_offset
            ) VALUES (:pipeline_version_id, :topic, :partition, :observed)
            ON CONFLICT (pipeline_version_id, topic, partition) DO UPDATE SET
                last_observed_offset = GREATEST(
                    realtime_partition_checkpoints.last_observed_offset,
                    EXCLUDED.last_observed_offset
                ),
                updated_at = CURRENT_TIMESTAMP
        """), {
            "pipeline_version_id": pipeline_version_id,
            "topic": audit.topic,
            "partition": audit.partition,
            "observed": audit.to_offset_inclusive,
        })
        if audit.status != "contiguous" or audit.advance_to_offset is None:
            return False
        result = self.session.execute(text("""
            UPDATE realtime_partition_checkpoints
            SET last_contiguously_received_offset = :advance,
                updated_at = CURRENT_TIMESTAMP
            WHERE pipeline_version_id = :pipeline_version_id
              AND topic = :topic
              AND partition = :partition
              AND last_contiguously_received_offset = :expected_previous
              AND last_applied_offset <= :advance
        """), {
            "pipeline_version_id": pipeline_version_id,
            "topic": audit.topic,
            "partition": audit.partition,
            "advance": audit.advance_to_offset,
            "expected_previous": expected_previous_contiguous,
        })
        return bool(result.rowcount == 1)

    def quarantine(
        self,
        *,
        pipeline_version_id: str,
        position: SourcePosition,
        payload_hash: str,
        error_code: str,
        quarantine_locator: str,
    ) -> None:
        self.session.execute(text("""
            INSERT INTO realtime_ingest_exceptions (
                pipeline_version_id, topic, partition, kafka_offset,
                payload_hash, quarantine_locator, error_code, status
            ) VALUES (
                :pipeline_version_id, :topic, :partition, :offset,
                :payload_hash, :locator, :error_code, 'quarantined'
            )
            ON CONFLICT (pipeline_version_id, topic, partition, kafka_offset)
            DO UPDATE SET
                payload_hash = EXCLUDED.payload_hash,
                quarantine_locator = EXCLUDED.quarantine_locator,
                error_code = EXCLUDED.error_code,
                updated_at = CURRENT_TIMESTAMP
            WHERE realtime_ingest_exceptions.status IN ('quarantined', 'replay_pending')
        """), {
            "pipeline_version_id": pipeline_version_id,
            "topic": position.topic,
            "partition": position.partition,
            "offset": position.offset,
            "payload_hash": payload_hash,
            "locator": quarantine_locator,
            "error_code": error_code,
        })

    def approve_skip(
        self,
        *,
        pipeline_version_id: str,
        position: SourcePosition,
        actor: str,
        reason: str,
    ) -> bool:
        if not actor.strip() or len(reason.strip()) < 10:
            raise ValueError("audited skip requires actor and a meaningful reason")
        result = self.session.execute(text("""
            UPDATE realtime_ingest_exceptions
            SET status = 'audited_skip', audit_actor = :actor,
                audit_reason = :reason, audited_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE pipeline_version_id = :pipeline_version_id
              AND topic = :topic AND partition = :partition
              AND kafka_offset = :offset
              AND status IN ('quarantined', 'replay_pending')
              AND quarantine_locator IS NOT NULL
        """), {
            "pipeline_version_id": pipeline_version_id,
            "topic": position.topic,
            "partition": position.partition,
            "offset": position.offset,
            "actor": actor.strip(),
            "reason": reason.strip(),
        })
        return bool(result.rowcount == 1)
