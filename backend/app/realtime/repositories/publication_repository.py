from __future__ import annotations

from datetime import UTC, datetime
import json

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.realtime.domain.publication import PublicationResult, RealtimePublication
from app.realtime.repositories.materialization_repository import MaterializationRepository
from app.repositories.catalog_repository import dataset_model_to_payload
from app.repositories.realtime_event_repository import RealtimeEventRepository


class RealtimePublicationRepository:
    """Atomic PostgreSQL publication. The caller owns commit and rollback."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def publish(self, publication: RealtimePublication) -> PublicationResult:
        idempotency_key = f"realtime-publication:{publication.materialization_id}"
        existing = self._existing_commit(publication.materialization_id)
        if existing is not None:
            self._validate_existing(existing, publication)
            event = RealtimeEventRepository(self.session).by_idempotency_key(idempotency_key)
            if event is None:
                raise RuntimeError("published materialization is missing its durable event")
            return PublicationResult(publication.dataset_id, int(existing.revision), int(event.id), False)

        freshness = self.session.scalars(
            select(DatasetFreshnessModel)
            .where(DatasetFreshnessModel.dataset_id == publication.dataset_id)
            .with_for_update()
        ).first()
        if freshness is None:
            raise ValueError("Dataset serving binding is not initialized")
        existing = self._existing_commit(publication.materialization_id)
        if existing is not None:
            self._validate_existing(existing, publication)
            event = RealtimeEventRepository(self.session).by_idempotency_key(idempotency_key)
            if event is None:
                raise RuntimeError("published materialization is missing its durable event")
            return PublicationResult(publication.dataset_id, int(existing.revision), int(event.id), False)
        if any((
            int(freshness.binding_epoch or 0) != publication.binding_epoch,
            freshness.active_serving_engine != "clickhouse",
            freshness.active_serving_version_id != publication.serving_version_id,
        )):
            raise ValueError("Dataset serving binding epoch or version is stale")

        lock_clause = "" if self.session.get_bind().dialect.name == "sqlite" else "FOR UPDATE"
        materialization = self.session.execute(text(f"""
            SELECT pipeline_version_id, source_fingerprint, dimension_version_ids,
                   lease_generation, target_row_count, target_checksum, status
            FROM realtime_materializations
            WHERE id = :id
            {lock_clause}
        """), {"id": publication.materialization_id}).mappings().first()
        if materialization is None:
            raise ValueError("materialization evidence or lease is stale")
        materialization_dimensions = materialization["dimension_version_ids"]
        if isinstance(materialization_dimensions, str):
            materialization_dimensions = json.loads(materialization_dimensions)
        if any((
            materialization["pipeline_version_id"] != publication.pipeline_version_id,
            materialization["source_fingerprint"] != publication.source_fingerprint,
            int(materialization["lease_generation"]) != publication.lease_generation,
            materialization["target_row_count"] is None,
            materialization["target_row_count"] is not None
            and int(materialization["target_row_count"]) != publication.row_count,
            str(materialization["target_checksum"] or "") != publication.checksum,
            dict(materialization_dimensions or {}) != publication.dimension_version_ids,
            materialization["status"] != "materialized",
        )):
            raise ValueError("materialization evidence or lease is stale")

        revision = int(freshness.latest_revision or 0) + 1
        MaterializationRepository(self.session).advance_checkpoints(
            pipeline_version_id=publication.pipeline_version_id,
            boundary=publication.boundary,
            lease_generation=publication.lease_generation,
        )
        updated = self.session.execute(text("""
            UPDATE realtime_materializations
            SET status = 'published', published_revision = :revision,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :id AND status = 'materialized'
              AND lease_generation = :lease_generation
              AND published_revision IS NULL
        """), {
            "id": publication.materialization_id,
            "revision": revision,
            "lease_generation": publication.lease_generation,
        })
        if updated.rowcount != 1:
            raise ValueError("materialization publication fencing failed")

        now = datetime.now(UTC)
        run_id = f"rt:{publication.materialization_id}"
        commit = DatasetRevisionCommitModel(
            dataset_id=publication.dataset_id,
            revision=revision,
            run_id=run_id,
            storage_location=(
                f"clickhouse://{publication.physical_database}/{publication.physical_table}"
            ),
            storage_format="clickhouse",
            materialization_mode="delta",
            commit_kind="realtime",
            row_count=publication.row_count,
            source_ranges=[item.document() for item in publication.boundary.partitions],
            source_fingerprint=publication.source_fingerprint,
            materialization_id=publication.materialization_id,
            source_boundary=publication.boundary.document(),
            serving_engine="clickhouse",
            serving_version_id=publication.serving_version_id,
            binding_epoch=publication.binding_epoch,
            dimension_version_ids=dict(publication.dimension_version_ids),
            mutation_type=publication.mutation_type,
            committed_at=now,
        )
        freshness.latest_revision = revision
        freshness.latest_run_id = run_id
        freshness.latest_source_boundary = publication.boundary.document()
        freshness.latest_checksum = publication.checksum
        freshness.latest_mutation_type = publication.mutation_type
        freshness.updated_at = now
        self.session.add(commit)
        self.session.add(freshness)
        self._update_catalog_binding(publication)
        self.session.flush()

        envelope, created = RealtimeEventRepository(self.session).append(
            event_type="dataset.revision.committed",
            resource_type="dataset",
            resource_id=publication.dataset_id,
            aggregate_revision=revision,
            correlation_id=publication.correlation_id,
            idempotency_key=idempotency_key,
            invalidations=[f"dataset:{publication.dataset_id}"],
            payload={
                "bindingEpoch": publication.binding_epoch,
                "materializationId": publication.materialization_id,
                "mutationType": publication.mutation_type,
                "sourceBoundary": publication.boundary.document(),
                "servingVersionId": publication.serving_version_id,
                "pipelineVersionId": publication.pipeline_version_id,
            },
            occurred_at=now,
            schema_version=2,
        )
        if not created:
            raise RuntimeError("new materialization collided with an existing event identity")
        return PublicationResult(publication.dataset_id, revision, envelope.event_id, True)

    @staticmethod
    def _validate_existing(
        existing: DatasetRevisionCommitModel,
        publication: RealtimePublication,
    ) -> None:
        if any((
            existing.dataset_id != publication.dataset_id,
            existing.source_fingerprint != publication.source_fingerprint,
            existing.serving_version_id != publication.serving_version_id,
            int(existing.binding_epoch or 0) != publication.binding_epoch,
            int(existing.row_count or 0) != publication.row_count,
            existing.mutation_type != publication.mutation_type,
        )):
            raise ValueError("materialization id was reused with different publication evidence")

    def _existing_commit(self, materialization_id: str) -> DatasetRevisionCommitModel | None:
        return self.session.scalars(
            select(DatasetRevisionCommitModel).where(
                DatasetRevisionCommitModel.materialization_id == materialization_id
            )
        ).first()

    def _update_catalog_binding(self, publication: RealtimePublication) -> None:
        model = self.session.scalars(
            select(CatalogDatasetModel)
            .where(CatalogDatasetModel.id == publication.dataset_id)
            .with_for_update()
        ).first()
        if model is None:
            raise ValueError("Catalog Dataset is missing for realtime publication")
        payload = dataset_model_to_payload(model)
        previous = payload.get("physicalBindings")
        bindings = [dict(item) for item in previous if isinstance(item, dict)] if isinstance(previous, list) else []
        for item in bindings:
            if item.get("role") == "serving" and item.get("status") == "active":
                item["status"] = "stale"
        bindings = [
            item for item in bindings
            if not (
                item.get("role") == "serving"
                and item.get("versionId") == publication.serving_version_id
            )
        ]
        bindings.append({
            "role": "serving",
            "engine": "clickhouse",
            "status": "active",
            "bindingEpoch": publication.binding_epoch,
            "versionId": publication.serving_version_id,
            "pipelineVersionId": publication.pipeline_version_id,
            "database": publication.physical_database,
            "table": publication.physical_table,
            "sourceBoundary": publication.boundary.document(),
            "checksum": publication.checksum,
            "dimensionVersionIds": dict(publication.dimension_version_ids),
        })
        payload["physicalBindings"] = bindings
        payload["clickhouseTable"] = {
            "database": publication.physical_database,
            "table": publication.physical_table,
        }
        model.payload = payload
        self.session.add(model)
