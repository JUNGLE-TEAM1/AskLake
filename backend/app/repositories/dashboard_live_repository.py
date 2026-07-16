from datetime import UTC, datetime
from dataclasses import dataclass
import hashlib
import json
import logging
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.base import Base
from app.models.dashboard_live import (
    DashboardWidgetResultModel,
    DatasetFreshnessModel,
    DatasetKafkaPartitionCursorModel,
    DatasetRevisionCommitModel,
)
from app.models.etl import ETLJobModel
from app.models.catalog import CatalogDatasetModel
from app.repositories.realtime_event_repository import RealtimeEventRepository


DEFAULT_DASHBOARD_POLL_MS = 1_000
MIN_DASHBOARD_POLL_MS = 1_000
MAX_DASHBOARD_POLL_MS = 60_000
logger = logging.getLogger(__name__)
STREAM_COMMIT_KIND = "stream"
REPLAY_COMMIT_KIND = "replay"
BACKFILL_COMMIT_KIND = "backfill"
LEGACY_COMMIT_KIND = "legacy"


def normalize_kafka_source_ranges(
    source_ranges: list[dict[str, Any]] | None,
    *,
    required: bool = False,
) -> list[dict[str, Any]]:
    """Validate and canonicalize end-exclusive Kafka offset ranges."""
    if not source_ranges:
        if required:
            raise ValueError("Kafka stream revision requires source ranges")
        return []
    if not isinstance(source_ranges, list):
        raise ValueError("Kafka source ranges must be a list")

    normalized: list[dict[str, Any]] = []
    for item in source_ranges:
        if not isinstance(item, dict):
            raise ValueError("Kafka source range must be an object")
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            start_offset = int(item.get("startOffset"))
            end_offset = int(item.get("endOffset"))
        except (TypeError, ValueError) as error:
            raise ValueError("Kafka source range offsets must be integers") from error
        if not topic:
            raise ValueError("Kafka source range requires topic")
        if len(topic) > 512:
            raise ValueError("Kafka source range topic is too long")
        if partition < 0 or start_offset < 0 or end_offset <= start_offset:
            raise ValueError("Kafka source range must satisfy partition >= 0 and 0 <= startOffset < endOffset")
        normalized.append({
            "topic": topic,
            "partition": partition,
            "startOffset": start_offset,
            "endOffset": end_offset,
        })

    normalized.sort(
        key=lambda item: (
            item["topic"],
            item["partition"],
            item["startOffset"],
            item["endOffset"],
        )
    )
    previous_by_partition: dict[tuple[str, int], dict[str, Any]] = {}
    for item in normalized:
        key = (str(item["topic"]), int(item["partition"]))
        previous = previous_by_partition.get(key)
        if previous is not None and int(item["startOffset"]) < int(previous["endOffset"]):
            raise ValueError("Kafka source ranges overlap inside one publication")
        previous_by_partition[key] = item
    return normalized


def kafka_source_fingerprint(source_ranges: list[dict[str, Any]]) -> str | None:
    if not source_ranges:
        return None
    canonical = json.dumps(source_ranges, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ContinuousDatasetRefreshRecord:
    id: str
    continuous_config: dict[str, Any]


def recommended_dashboard_poll_ms(trigger_interval_seconds: Any) -> int:
    try:
        trigger_seconds = max(1, int(trigger_interval_seconds))
    except (TypeError, ValueError):
        trigger_seconds = 30
    return max(
        MIN_DASHBOARD_POLL_MS,
        min(MAX_DASHBOARD_POLL_MS, trigger_seconds * 500),
    )


def ensure_dashboard_live_schema(db: Session) -> None:
    """Create the additive live-dashboard tables for new and existing databases."""
    bind = db.get_bind()
    Base.metadata.create_all(
        bind=bind,
        tables=[
            DatasetFreshnessModel.__table__,
            DatasetRevisionCommitModel.__table__,
            DatasetKafkaPartitionCursorModel.__table__,
            DashboardWidgetResultModel.__table__,
        ],
    )
    if bind.dialect.name == "postgresql":
        # create_all handles fresh databases. These ALTERs keep existing local
        # volumes forward-compatible when a column is added later.
        for statement in (
            "ALTER TABLE dataset_freshness ADD COLUMN IF NOT EXISTS next_check_after_ms integer NOT NULL DEFAULT 1000",
            "ALTER TABLE dataset_freshness DROP CONSTRAINT IF EXISTS dataset_freshness_next_check_after_ms_check",
            "ALTER TABLE dataset_freshness ALTER COLUMN next_check_after_ms SET DEFAULT 1000",
            "ALTER TABLE dataset_freshness ADD CONSTRAINT dataset_freshness_next_check_after_ms_check CHECK (next_check_after_ms BETWEEN 1000 AND 60000)",
            "ALTER TABLE dashboard_widget_results ADD COLUMN IF NOT EXISTS calculation_state jsonb NOT NULL DEFAULT '{}'::jsonb",
            "ALTER TABLE dashboard_widget_results ADD COLUMN IF NOT EXISTS calculation_mode varchar(32) NOT NULL DEFAULT 'full'",
            "ALTER TABLE dataset_revision_commits ADD COLUMN IF NOT EXISTS source_ranges jsonb NOT NULL DEFAULT '[]'::jsonb",
            "ALTER TABLE dataset_revision_commits ADD COLUMN IF NOT EXISTS commit_kind varchar(32) NOT NULL DEFAULT 'legacy'",
            "ALTER TABLE dataset_revision_commits ADD COLUMN IF NOT EXISTS source_fingerprint varchar(64)",
            "ALTER TABLE dataset_revision_commits ADD COLUMN IF NOT EXISTS manifest_location varchar(2048)",
            "CREATE TABLE IF NOT EXISTS dashboard_live_schema_migrations (version varchar(96) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT NOW())",
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM dashboard_live_schema_migrations WHERE version = '20260714_kafka_partition_cursor_v1') THEN UPDATE dataset_revision_commits SET commit_kind = CASE WHEN materialization_mode = 'snapshot' THEN 'backfill' WHEN run_id LIKE 'continuous-replay_%' THEN 'replay' WHEN run_id LIKE 'continuous:%:batch:%' THEN 'stream' ELSE commit_kind END WHERE commit_kind = 'legacy'; INSERT INTO dataset_kafka_partition_cursors (dataset_id, commit_kind, topic, partition, next_offset, updated_revision, updated_at) SELECT commits.dataset_id, 'stream', ranges.item ->> 'topic', (ranges.item ->> 'partition')::integer, MAX((ranges.item ->> 'endOffset')::bigint), MAX(commits.revision), NOW() FROM dataset_revision_commits AS commits CROSS JOIN LATERAL jsonb_array_elements(commits.source_ranges) AS ranges(item) WHERE commits.commit_kind IN ('stream', 'backfill') AND jsonb_typeof(commits.source_ranges) = 'array' AND ranges.item ? 'topic' AND ranges.item ? 'partition' AND ranges.item ? 'endOffset' AND (ranges.item ->> 'partition') ~ '^[0-9]+$' AND (ranges.item ->> 'endOffset') ~ '^[0-9]+$' GROUP BY commits.dataset_id, ranges.item ->> 'topic', (ranges.item ->> 'partition')::integer ON CONFLICT (dataset_id, commit_kind, topic, partition) DO UPDATE SET next_offset = GREATEST(dataset_kafka_partition_cursors.next_offset, EXCLUDED.next_offset), updated_revision = GREATEST(dataset_kafka_partition_cursors.updated_revision, EXCLUDED.updated_revision), updated_at = NOW(); INSERT INTO dashboard_live_schema_migrations (version) VALUES ('20260714_kafka_partition_cursor_v1'); END IF; END $$",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN result_payload TYPE jsonb USING result_payload::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN calculation_state TYPE jsonb USING calculation_state::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN result_payload SET DEFAULT '{}'::jsonb",
            "ALTER TABLE dashboard_widget_results ALTER COLUMN calculation_state SET DEFAULT '{}'::jsonb",
            "CREATE INDEX IF NOT EXISTS dataset_revision_commits_dataset_revision_idx ON dataset_revision_commits (dataset_id, revision)",
            "CREATE UNIQUE INDEX IF NOT EXISTS dataset_revision_commits_source_fingerprint_uq ON dataset_revision_commits (dataset_id, commit_kind, source_fingerprint) WHERE source_fingerprint IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS dashboard_widget_results_dataset_revision_idx ON dashboard_widget_results (dataset_id, applied_revision)",
        ):
            db.execute(text(statement))
    db.commit()


class DashboardLiveRepository:
    def __init__(self, db: Session, *, ensure_schema: bool = True) -> None:
        self.db = db
        if ensure_schema:
            ensure_dashboard_live_schema(db)

    def get_freshness(self, dataset_id: str, *, for_update: bool = False) -> DatasetFreshnessModel | None:
        statement = select(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id == dataset_id)
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def list_freshness(self, dataset_ids: list[str]) -> dict[str, DatasetFreshnessModel]:
        if not dataset_ids:
            return {}
        statement = select(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id.in_(dataset_ids))
        return {item.dataset_id: item for item in self.db.scalars(statement).all()}

    def continuous_job_by_dataset(self, dataset_id: str) -> ContinuousDatasetRefreshRecord | None:
        statement = (
            select(ETLJobModel.id, ETLJobModel.continuous_config)
            .where(
                ETLJobModel.dataset_id == dataset_id,
                ETLJobModel.execution_mode == "continuous",
                ETLJobModel.source_type.ilike("%kafka%"),
            )
            .order_by(ETLJobModel.updated_at.desc(), ETLJobModel.created_at.desc())
            .limit(1)
        )
        row = self.db.execute(statement).first()
        if row is None:
            return None
        return ContinuousDatasetRefreshRecord(
            id=str(row.id),
            continuous_config=dict(row.continuous_config or {}),
        )

    def commit_by_run_id(self, run_id: str) -> DatasetRevisionCommitModel | None:
        return self.db.scalars(
            select(DatasetRevisionCommitModel).where(DatasetRevisionCommitModel.run_id == run_id)
        ).first()

    def commit_by_source_fingerprint(
        self,
        dataset_id: str,
        commit_kind: str,
        source_fingerprint: str,
    ) -> DatasetRevisionCommitModel | None:
        return self.db.scalars(
            select(DatasetRevisionCommitModel).where(
                DatasetRevisionCommitModel.dataset_id == dataset_id,
                DatasetRevisionCommitModel.commit_kind == commit_kind,
                DatasetRevisionCommitModel.source_fingerprint == source_fingerprint,
            )
        ).first()

    def stream_partition_cursor(
        self,
        dataset_id: str,
        topic: str,
        partition: int,
        *,
        for_update: bool = False,
    ) -> DatasetKafkaPartitionCursorModel | None:
        statement = select(DatasetKafkaPartitionCursorModel).where(
            DatasetKafkaPartitionCursorModel.dataset_id == dataset_id,
            DatasetKafkaPartitionCursorModel.commit_kind == STREAM_COMMIT_KIND,
            DatasetKafkaPartitionCursorModel.topic == topic,
            DatasetKafkaPartitionCursorModel.partition == partition,
        )
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def list_stream_partition_cursors(
        self,
        dataset_id: str,
        *,
        topic: str | None = None,
    ) -> list[dict[str, Any]]:
        statement = select(DatasetKafkaPartitionCursorModel).where(
            DatasetKafkaPartitionCursorModel.dataset_id == dataset_id,
            DatasetKafkaPartitionCursorModel.commit_kind == STREAM_COMMIT_KIND,
        )
        normalized_topic = str(topic or "").strip()
        if normalized_topic:
            statement = statement.where(
                DatasetKafkaPartitionCursorModel.topic == normalized_topic
            )
        statement = statement.order_by(
            DatasetKafkaPartitionCursorModel.topic,
            DatasetKafkaPartitionCursorModel.partition,
        )
        return [
            {
                "topic": str(cursor.topic),
                "partition": int(cursor.partition),
                "nextOffset": int(cursor.next_offset),
            }
            for cursor in self.db.scalars(statement).all()
        ]

    def lock_dataset_publication_identity(self, dataset_id: str) -> None:
        bind = self.db.get_bind()
        if bind.dialect.name != "postgresql":
            return
        self.db.execute(
            text(
                "SELECT pg_advisory_xact_lock("
                "hashtextextended(:lock_key, 0)"
                ")"
            ),
            {"lock_key": f"asklake:catalog-publication:{dataset_id}"},
        )

    def record_stream_progress(
        self,
        dataset_id: str,
        source_ranges: list[dict[str, Any]] | None,
        *,
        updated_at: datetime | None = None,
    ) -> bool:
        normalized_ranges = normalize_kafka_source_ranges(source_ranges, required=True)
        freshness = self.get_freshness(dataset_id)
        revision = int(freshness.latest_revision or 0) if freshness is not None else 0
        now = updated_at or datetime.now(UTC)
        by_partition: dict[tuple[str, int], tuple[int, int]] = {}
        for item in normalized_ranges:
            key = (str(item["topic"]), int(item["partition"]))
            start_offset = int(item["startOffset"])
            end_offset = int(item["endOffset"])
            current = by_partition.get(key)
            by_partition[key] = (
                min(current[0], start_offset) if current else start_offset,
                max(current[1], end_offset) if current else end_offset,
            )

        advanced = False
        for (topic, partition), (start_offset, end_offset) in by_partition.items():
            cursor = self.stream_partition_cursor(
                dataset_id,
                topic,
                partition,
                for_update=True,
            )
            if cursor is not None:
                next_offset = int(cursor.next_offset)
                if end_offset <= next_offset:
                    continue
                if start_offset < next_offset:
                    raise ValueError(
                        "Kafka stream source range partially overlaps the committed partition watermark"
                    )
                cursor.next_offset = end_offset
                cursor.updated_revision = max(int(cursor.updated_revision), revision)
                cursor.updated_at = now
            else:
                cursor = DatasetKafkaPartitionCursorModel(
                    dataset_id=dataset_id,
                    commit_kind=STREAM_COMMIT_KIND,
                    topic=topic,
                    partition=partition,
                    next_offset=end_offset,
                    updated_revision=revision,
                    updated_at=now,
                )
            self.db.add(cursor)
            advanced = True
        self.db.flush()
        return advanced

    def advance_stream_partition_cursors(
        self,
        dataset_id: str,
        source_ranges: list[dict[str, Any]],
        revision: int,
        updated_at: datetime,
    ) -> None:
        by_partition: dict[tuple[str, int], tuple[int, int]] = {}
        for item in source_ranges:
            key = (str(item["topic"]), int(item["partition"]))
            start_offset = int(item["startOffset"])
            end_offset = int(item["endOffset"])
            current = by_partition.get(key)
            by_partition[key] = (
                min(current[0], start_offset) if current else start_offset,
                max(current[1], end_offset) if current else end_offset,
            )

        for (topic, partition), (start_offset, end_offset) in by_partition.items():
            cursor = self.stream_partition_cursor(
                dataset_id,
                topic,
                partition,
                for_update=True,
            )
            if cursor is not None and start_offset < int(cursor.next_offset):
                raise ValueError(
                    "Kafka stream source range precedes or overlaps the committed partition watermark"
                )
            if cursor is None:
                cursor = DatasetKafkaPartitionCursorModel(
                    dataset_id=dataset_id,
                    commit_kind=STREAM_COMMIT_KIND,
                    topic=topic,
                    partition=partition,
                    next_offset=end_offset,
                    updated_revision=revision,
                    updated_at=updated_at,
                )
            else:
                cursor.next_offset = max(int(cursor.next_offset), end_offset)
                cursor.updated_revision = revision
                cursor.updated_at = updated_at
            self.db.add(cursor)

    def seed_stream_partition_cursors(
        self,
        dataset_id: str,
        source_ranges: list[dict[str, Any]],
        revision: int,
        updated_at: datetime,
    ) -> None:
        by_partition: dict[tuple[str, int], int] = {}
        for item in source_ranges:
            key = (str(item["topic"]), int(item["partition"]))
            by_partition[key] = max(
                by_partition.get(key, 0),
                int(item["endOffset"]),
            )
        for (topic, partition), end_offset in by_partition.items():
            cursor = self.stream_partition_cursor(
                dataset_id,
                topic,
                partition,
                for_update=True,
            )
            if cursor is None:
                cursor = DatasetKafkaPartitionCursorModel(
                    dataset_id=dataset_id,
                    commit_kind=STREAM_COMMIT_KIND,
                    topic=topic,
                    partition=partition,
                    next_offset=end_offset,
                    updated_revision=revision,
                    updated_at=updated_at,
                )
            else:
                cursor.next_offset = max(int(cursor.next_offset), end_offset)
                cursor.updated_revision = max(int(cursor.updated_revision), revision)
                cursor.updated_at = updated_at
            self.db.add(cursor)

    def record_dataset_commit(
        self,
        *,
        dataset_id: str,
        run_id: str,
        storage_location: str,
        storage_format: str,
        materialization_mode: str,
        row_count: int,
        next_check_after_ms: int,
        committed_at: datetime | None = None,
        source_ranges: list[dict[str, Any]] | None = None,
        commit_kind: str = LEGACY_COMMIT_KIND,
        manifest_location: str | None = None,
    ) -> tuple[DatasetRevisionCommitModel, bool]:
        normalized_commit_kind = str(commit_kind or LEGACY_COMMIT_KIND).strip().lower()
        if normalized_commit_kind not in {
            STREAM_COMMIT_KIND,
            REPLAY_COMMIT_KIND,
            BACKFILL_COMMIT_KIND,
            LEGACY_COMMIT_KIND,
        }:
            raise ValueError(f"Unsupported dataset commit kind: {normalized_commit_kind}")
        normalized_ranges = normalize_kafka_source_ranges(
            source_ranges,
            required=normalized_commit_kind in {STREAM_COMMIT_KIND, REPLAY_COMMIT_KIND},
        )
        source_fingerprint = kafka_source_fingerprint(normalized_ranges)
        normalized_storage_location = str(storage_location or "").strip()
        normalized_manifest_location = str(manifest_location or "").strip() or None
        normalized_row_count = max(0, int(row_count or 0))
        if normalized_commit_kind in {STREAM_COMMIT_KIND, REPLAY_COMMIT_KIND}:
            if not normalized_storage_location:
                raise ValueError("Kafka revision requires a durable storage location")
            if normalized_manifest_location is None:
                raise ValueError("Kafka revision requires a publication manifest")

        existing_commit = self.commit_by_run_id(run_id)
        if existing_commit is not None:
            existing_ranges = normalize_kafka_source_ranges(
                list(existing_commit.source_ranges or []),
                required=False,
            )
            existing_manifest_location = str(existing_commit.manifest_location or "").strip()
            mismatched = any((
                existing_commit.dataset_id != dataset_id,
                str(existing_commit.storage_location or "").strip() != normalized_storage_location,
                str(existing_commit.storage_format or "").strip().lower() != str(storage_format or "parquet").strip().lower(),
                str(existing_commit.materialization_mode or "").strip().lower() != str(materialization_mode or "delta").strip().lower(),
                str(existing_commit.commit_kind or LEGACY_COMMIT_KIND).strip().lower() != normalized_commit_kind,
                int(existing_commit.row_count or 0) != normalized_row_count,
                existing_ranges != normalized_ranges,
                (
                    normalized_manifest_location is not None
                    and bool(existing_manifest_location)
                    and existing_manifest_location != normalized_manifest_location
                ),
            ))
            if mismatched:
                raise ValueError("Dataset revision run_id was reused with different publication metadata")
            if normalized_manifest_location is not None and not existing_manifest_location:
                existing_commit.manifest_location = normalized_manifest_location
                if source_fingerprint and not existing_commit.source_fingerprint:
                    existing_commit.source_fingerprint = source_fingerprint
                self.db.add(existing_commit)
                self.db.flush()
            return existing_commit, False

        freshness = self.get_freshness(dataset_id, for_update=True)
        now = committed_at or datetime.now(UTC)
        resolved_check_after_ms = max(
            MIN_DASHBOARD_POLL_MS,
            min(MAX_DASHBOARD_POLL_MS, int(next_check_after_ms or DEFAULT_DASHBOARD_POLL_MS)),
        )
        if freshness is None:
            freshness = DatasetFreshnessModel(
                dataset_id=dataset_id,
                latest_revision=0,
                next_check_after_ms=resolved_check_after_ms,
                updated_at=now,
            )
            self.db.add(freshness)
            self.db.flush()

        if source_fingerprint:
            duplicate_source = self.commit_by_source_fingerprint(
                dataset_id,
                normalized_commit_kind,
                source_fingerprint,
            )
            if duplicate_source is not None:
                return duplicate_source, False

        revision = int(freshness.latest_revision or 0) + 1
        if normalized_commit_kind == STREAM_COMMIT_KIND:
            self.advance_stream_partition_cursors(
                dataset_id,
                normalized_ranges,
                revision,
                now,
            )
        commit = DatasetRevisionCommitModel(
            dataset_id=dataset_id,
            revision=revision,
            run_id=run_id,
            storage_location=normalized_storage_location,
            storage_format=storage_format or "parquet",
            materialization_mode=materialization_mode or "delta",
            commit_kind=normalized_commit_kind,
            row_count=normalized_row_count,
            source_ranges=normalized_ranges,
            source_fingerprint=source_fingerprint,
            manifest_location=normalized_manifest_location,
            committed_at=now,
        )
        freshness.latest_revision = revision
        freshness.latest_run_id = run_id
        freshness.next_check_after_ms = resolved_check_after_ms
        freshness.updated_at = now
        self.db.add(commit)
        self.db.add(freshness)
        self.db.flush()
        if settings.realtime_events_enabled:
            RealtimeEventRepository(self.db).append(
                event_type="dataset.revision.committed",
                resource_type="dataset",
                resource_id=dataset_id,
                aggregate_revision=revision,
                correlation_id=run_id,
                idempotency_key=f"dataset:{dataset_id}:revision:{revision}",
                invalidations=[
                    f"dataset:{dataset_id}:freshness",
                    f"dashboard-widgets-by-dataset:{dataset_id}",
                ],
                payload={
                    "runId": run_id,
                    "commitKind": normalized_commit_kind,
                },
                occurred_at=now,
            )
        return commit, True

    def list_commits(
        self,
        dataset_id: str,
        *,
        after_revision: int = -1,
        through_revision: int | None = None,
    ) -> list[DatasetRevisionCommitModel]:
        statement = select(DatasetRevisionCommitModel).where(
            DatasetRevisionCommitModel.dataset_id == dataset_id,
            DatasetRevisionCommitModel.revision > after_revision,
        )
        if through_revision is not None:
            statement = statement.where(DatasetRevisionCommitModel.revision <= through_revision)
        return list(self.db.scalars(statement.order_by(DatasetRevisionCommitModel.revision.asc())).all())

    def get_widget_result(
        self,
        widget_id: str,
        calculation_version: str,
        *,
        for_update: bool = False,
    ) -> DashboardWidgetResultModel | None:
        statement = select(DashboardWidgetResultModel).where(
            DashboardWidgetResultModel.widget_id == widget_id,
            DashboardWidgetResultModel.calculation_version == calculation_version,
        )
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalars(statement).first()

    def latest_widget_result(
        self,
        widget_id: str,
        dataset_id: str,
    ) -> DashboardWidgetResultModel | None:
        return self.db.scalars(
            select(DashboardWidgetResultModel)
            .where(
                DashboardWidgetResultModel.widget_id == widget_id,
                DashboardWidgetResultModel.dataset_id == dataset_id,
            )
            .order_by(
                DashboardWidgetResultModel.calculated_at.desc(),
                DashboardWidgetResultModel.calculation_version.desc(),
            )
            .limit(1)
        ).first()

    def save_widget_result(
        self,
        *,
        widget_id: str,
        calculation_version: str,
        dataset_id: str,
        applied_revision: int,
        result_payload: dict[str, Any],
        calculation_state: dict[str, Any],
        calculation_mode: str,
    ) -> DashboardWidgetResultModel:
        result = self.get_widget_result(widget_id, calculation_version, for_update=True)
        if result is None:
            result = DashboardWidgetResultModel(
                widget_id=widget_id,
                calculation_version=calculation_version,
                dataset_id=dataset_id,
            )
        result.dataset_id = dataset_id
        result.applied_revision = max(0, int(applied_revision or 0))
        result.result_payload = result_payload
        result.calculation_state = calculation_state
        result.calculation_mode = calculation_mode
        result.calculated_at = datetime.now(UTC)
        self.db.execute(
            delete(DashboardWidgetResultModel).where(
                DashboardWidgetResultModel.widget_id == widget_id,
                DashboardWidgetResultModel.calculation_version != calculation_version,
            )
        )
        self.db.add(result)
        self.db.flush()
        return result


def save_catalog_dataset_and_revision(
    db: Session,
    dataset: CatalogDatasetModel,
    *,
    run_id: str,
    storage_location: str,
    storage_format: str,
    materialization_mode: str,
    row_count: int,
    next_check_after_ms: int,
    source_ranges: list[dict[str, Any]] | None = None,
    commit_kind: str = STREAM_COMMIT_KIND,
    manifest_location: str | None = None,
) -> DatasetRevisionCommitModel:
    """Commit Catalog metadata and its visible dashboard revision atomically."""
    commit: DatasetRevisionCommitModel | None = None
    merged_dataset: CatalogDatasetModel | None = None
    for attempt in range(2):
        repository = DashboardLiveRepository(db, ensure_schema=False)
        try:
            commit, created = repository.record_dataset_commit(
                dataset_id=dataset.id,
                run_id=run_id,
                storage_location=storage_location,
                storage_format=storage_format,
                materialization_mode=materialization_mode,
                row_count=row_count,
                next_check_after_ms=next_check_after_ms,
                source_ranges=source_ranges,
                commit_kind=commit_kind,
                manifest_location=manifest_location,
            )
            merged_dataset = db.merge(dataset) if created else None
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
        except Exception:
            db.rollback()
            raise
    if commit is None:
        raise RuntimeError("Dataset revision commit did not complete")
    if merged_dataset is not None:
        db.refresh(merged_dataset)
    logger.info(
        "dashboard_dataset_revision_committed dataset_id=%s revision=%s run_id=%s row_count=%s",
        dataset.id,
        commit.revision,
        run_id,
        row_count,
    )
    return commit


def backfill_catalog_revision(
    db: Session,
    *,
    dataset_id: str,
    run_id: str,
    storage_location: str,
    storage_format: str,
    materialization_mode: str,
    row_count: int,
    next_check_after_ms: int,
    source_ranges: list[dict[str, Any]] | None = None,
    manifest_location: str | None = None,
) -> DatasetRevisionCommitModel:
    """Add revision metadata for a durable legacy Catalog run exactly once."""
    commit: DatasetRevisionCommitModel | None = None
    for attempt in range(2):
        repository = DashboardLiveRepository(db, ensure_schema=False)
        try:
            commit, _created = repository.record_dataset_commit(
                dataset_id=dataset_id,
                run_id=run_id,
                storage_location=storage_location,
                storage_format=storage_format,
                materialization_mode=materialization_mode,
                row_count=row_count,
                next_check_after_ms=next_check_after_ms,
                source_ranges=source_ranges,
                commit_kind=BACKFILL_COMMIT_KIND,
                manifest_location=manifest_location,
            )
            normalized_ranges = normalize_kafka_source_ranges(source_ranges, required=False)
            if normalized_ranges:
                repository.seed_stream_partition_cursors(
                    dataset_id,
                    normalized_ranges,
                    int(commit.revision),
                    datetime.now(UTC),
                )
                db.flush()
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
        except Exception:
            db.rollback()
            raise
    if commit is None:
        raise RuntimeError("Dataset revision backfill did not complete")
    logger.info(
        "dashboard_dataset_revision_backfilled dataset_id=%s revision=%s run_id=%s",
        dataset_id,
        commit.revision,
        run_id,
    )
    return commit
