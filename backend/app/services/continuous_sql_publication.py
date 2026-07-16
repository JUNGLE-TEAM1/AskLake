from __future__ import annotations

from datetime import UTC, datetime
import hashlib
from typing import Any

from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel
from app.models.continuous_sql import (
    ContinuousSqlBatchModel,
    ContinuousSqlJobModel,
    ContinuousSqlRunModel,
)
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import (
    STREAM_COMMIT_KIND,
    save_catalog_dataset_and_revision,
)
from app.schemas.iceberg import IcebergWriterTarget
from app.services.iceberg_writer_service import IcebergWriterError, IcebergWriterService


class ContinuousSqlPublicationError(RuntimeError):
    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


class ContinuousSqlPublicationService:
    def __init__(
        self,
        db: Session,
        *,
        writer: IcebergWriterService | None = None,
    ) -> None:
        self.db = db
        self.repository = ContinuousSqlRepository(db)
        self.catalog_repository = CatalogRepository(db)
        self.writer = writer or IcebergWriterService()

    def reconcile_manifest(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        publication: dict[str, Any],
    ) -> ContinuousSqlBatchModel:
        evidence = validate_publication_identity(job, run, publication)
        batch = self._stage_manifest_batch(job, run, evidence)
        if batch.stage == "dashboard_ready" or evidence["rowCount"] == 0:
            return batch

        verified = self._verify_output_commit(job, run, evidence)
        if verified is None:
            failed_batch = self.repository.get_batch(job.id, run.generation, evidence["batchId"])
            if failed_batch is None:
                raise ContinuousSqlPublicationError("CONTINUOUS_SQL_BATCH_MISSING")
            return failed_batch
        return self._publish_verified_commit(job, run, evidence, verified)

    def _stage_manifest_batch(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        evidence: dict[str, Any],
    ) -> ContinuousSqlBatchModel:
        batch = ContinuousSqlBatchModel(
            id=f"{job.id}:{run.generation}:{evidence['batchId']}",
            job_id=job.id,
            run_id=run.run_id,
            generation=run.generation,
            batch_id=evidence["batchId"],
            stage="output_committed",
            plan_hash=job.plan_hash,
            input_offsets=evidence["sourceRanges"],
            static_snapshots=evidence["staticSnapshots"],
            source_boundary=evidence["sourceBoundary"],
            output_commit=evidence["icebergCommit"],
            output_commit_id=evidence["publicationRunId"],
            manifest_path=evidence["manifestPath"],
            row_count=evidence["rowCount"],
            published_at=evidence["publishedAt"],
        )
        batch, _created = self.repository.stage_batch(batch)
        if batch.stage == "dashboard_ready":
            return batch
        if evidence["rowCount"] == 0:
            batch.stage = "dashboard_ready"
            batch.last_error_code = None
            batch.last_error_message = None
            self.db.add(batch)
            self.db.commit()
            return batch
        self.db.commit()
        return batch

    def _verify_output_commit(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        evidence: dict[str, Any],
    ) -> Any | None:
        target = IcebergWriterTarget.model_validate(job.output_target)
        commit = evidence["icebergCommit"]
        snapshot_id = str(commit.get("snapshotId") or "").strip()
        if not snapshot_id:
            raise ContinuousSqlPublicationError(
                "CONTINUOUS_SQL_OUTPUT_COMMIT_MISSING",
                "Continuous SQL output commit does not include an Iceberg snapshot.",
            )
        try:
            verified = self.writer.verify_commit(
                target,
                created_table=False,
                job_id=job.id,
                run_id=evidence["publicationRunId"],
                expected_snapshot_id=snapshot_id,
                schema_fingerprint=str(job.compiled_plan.get("schemaFingerprint") or "") or None,
                rule_fingerprint=job.plan_hash,
                source_boundary=evidence["sourceBoundary"],
            )
            self.writer.verify_snapshot_run_row_count(
                target,
                snapshot_id=verified.snapshot_id,
                run_id=evidence["publicationRunId"],
                expected_row_count=evidence["rowCount"],
            )
        except IcebergWriterError as exc:
            batch = self.repository.get_batch(job.id, run.generation, evidence["batchId"])
            if batch is None:
                raise
            batch.stage = "output_committed"
            batch.last_error_code = f"CONTINUOUS_SQL_CATALOG_{exc.code}"
            batch.last_error_message = str(exc)
            self.db.add(batch)
            self.db.commit()
            return None
        return verified

    def _publish_verified_commit(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        evidence: dict[str, Any],
        verified: Any,
    ) -> ContinuousSqlBatchModel:
        batch = self.repository.get_batch(job.id, run.generation, evidence["batchId"])
        if batch is None:
            raise ContinuousSqlPublicationError("CONTINUOUS_SQL_BATCH_MISSING")
        batch.stage = "catalog_ready"
        batch.output_commit = verified.model_dump(mode="json", by_alias=True)
        batch.last_error_code = None
        batch.last_error_message = None
        self.db.add(batch)
        self.db.commit()

        dataset = self._catalog_dataset(job, evidence, verified.model_dump(mode="json", by_alias=True))
        commit_record = save_catalog_dataset_and_revision(
            self.db,
            dataset,
            run_id=evidence["publicationRunId"],
            storage_location=verified.warehouse_location,
            storage_format="iceberg",
            materialization_mode="delta",
            row_count=evidence["rowCount"],
            next_check_after_ms=max(1_000, min(60_000, int(job.trigger_interval_seconds) * 500)),
            source_ranges=evidence["sourceRanges"],
            commit_kind=STREAM_COMMIT_KIND,
            manifest_location=evidence["manifestPath"],
        )
        batch = self.repository.get_batch(job.id, run.generation, evidence["batchId"])
        if batch is None:
            raise ContinuousSqlPublicationError("CONTINUOUS_SQL_BATCH_MISSING")
        batch.stage = "dashboard_ready"
        batch.dataset_revision = int(commit_record.revision)
        batch.last_error_code = None
        batch.last_error_message = None
        self.db.add(batch)
        self.db.commit()
        return batch

    def _catalog_dataset(
        self,
        job: ContinuousSqlJobModel,
        evidence: dict[str, Any],
        verified: dict[str, Any],
    ) -> CatalogDatasetModel:
        existing = self.catalog_repository.get_dataset_model_for_update(job.output_dataset_id)
        previous_payload = dict(existing.payload or {}) if existing is not None else {}
        payload, output_schema, relation_ids, now = self._catalog_payload(
            job, evidence, verified, previous_payload,
        )
        values = {
            "payload": payload,
            "name": job.output_dataset_name,
            "description": payload["description"],
            "owner": job.owner,
            "layer": job.output_layer,
            "status": "available",
            "freshness": "latest",
            "source": job.name,
            "rows": payload["rows"],
            "size": payload["size"],
            "quality": payload["quality"],
            "last_updated": now,
            "next_refresh": payload["nextRefresh"],
            "rag": payload["rag"],
            "tags": payload["tags"],
            "schema_json": output_schema,
            "sample_rows": payload["sampleRows"],
            "upstream": relation_ids,
            "downstream": payload["downstream"],
            "lineage_graph": previous_payload.get("lineageGraph"),
        }
        if existing is None:
            return CatalogDatasetModel(id=job.output_dataset_id, **values)
        for key, value in values.items():
            setattr(existing, key, value)
        return existing

    @staticmethod
    def _catalog_payload(
        job: ContinuousSqlJobModel,
        evidence: dict[str, Any],
        verified: dict[str, Any],
        previous_payload: dict[str, Any],
    ) -> tuple[dict[str, Any], list[list[str]], list[str], str]:
        now = str(evidence["publishedAt"] or datetime.now(UTC).isoformat())
        materialization_run = {
            "createdAt": now,
            "icebergCommittedAt": verified.get("committedAt"),
            "icebergSnapshotId": verified.get("snapshotId"),
            "jobId": job.id,
            "materializationMode": "delta",
            "publicationManifest": evidence["manifestPath"],
            "rowCount": evidence["rowCount"],
            "runId": evidence["publicationRunId"],
            "sourceBoundary": evidence["sourceBoundary"],
            "sourceKind": "continuous_sql",
            "sourceLabel": job.name,
            "sourceRanges": evidence["sourceRanges"],
            "staticSnapshots": evidence["staticSnapshots"],
            "status": "success",
            "storageFormat": "iceberg",
            "storageLocation": verified.get("warehouseLocation"),
            "queryEngineTable": verified.get("queryEngineTable"),
        }
        previous_runs = [
            item for item in previous_payload.get("materializationRuns") or []
            if isinstance(item, dict) and str(item.get("runId") or "") != evidence["publicationRunId"]
        ]
        runs = [*previous_runs, materialization_run][-100:]
        previous_rows = parse_display_count(previous_payload.get("rows"))
        total_rows = previous_rows + int(evidence["rowCount"])
        output_schema = [
            [str(item[0]), str(item[1])]
            for item in job.compiled_plan.get("outputSchema") or []
            if isinstance(item, (list, tuple)) and len(item) >= 2
        ]
        target = IcebergWriterTarget.model_validate(job.output_target)
        relation_ids = [
            str(item.get("datasetId") or "")
            for item in job.relation_bindings or []
            if isinstance(item, dict) and str(item.get("datasetId") or "")
        ]
        payload: dict[str, Any] = {
            **previous_payload,
            "createdBy": previous_payload.get("createdBy") or job.created_by,
            "description": previous_payload.get("description") or f"Continuous SQL output for {job.name}",
            "downstream": previous_payload.get("downstream") or ["Dashboard", "SQL 분석"],
            "freshness": "latest",
            "icebergSnapshotId": verified.get("snapshotId"),
            "id": job.output_dataset_id,
            "indexColumns": previous_payload.get("indexColumns") or [],
            "lastUpdated": now,
            "layer": job.output_layer,
            "materializationRuns": runs,
            "name": job.output_dataset_name,
            "nextRefresh": f"약 {job.trigger_interval_seconds}초마다",
            "owner": job.owner,
            "partitionColumns": target.partition_columns,
            "permissionGrants": previous_payload.get("permissionGrants") or permission_grants_from_roles(
                job.owner,
                default_actions=["view", "query"],
            ),
            "permissions": previous_payload.get("permissions") or resource_permissions(can_query=True),
            "quality": "Continuous SQL publication verified",
            "queryEngineStatus": "available",
            "queryEngineTable": target.query_engine_table().model_dump(mode="json", by_alias=True),
            "rag": bool(previous_payload.get("rag")),
            "relationMode": "static",
            "rows": f"{total_rows:,}",
            "sampleRows": previous_payload.get("sampleRows") or [],
            "schema": output_schema,
            "size": previous_payload.get("size") or "Pending",
            "source": job.name,
            "sourceRunId": evidence["publicationRunId"],
            "status": "available",
            "storageFormat": "iceberg",
            "storageLocation": verified.get("warehouseLocation"),
            "tags": previous_payload.get("tags") or ["continuous-sql"],
            "upstream": relation_ids,
        }
        return payload, output_schema, relation_ids, now


def validate_publication_identity(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    publication: dict[str, Any],
) -> dict[str, Any]:
    try:
        batch_id = int(publication.get("batchId"))
        generation = int(publication.get("continuousSqlRunGeneration"))
        row_count = int(publication.get("storedCount") or 0)
    except (TypeError, ValueError) as exc:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_PUBLICATION_ID_INVALID") from exc
    if batch_id < 0 or generation != run.generation or row_count < 0:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_PUBLICATION_ID_INVALID")
    if str(publication.get("continuousSqlPlanHash") or "") != job.plan_hash:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_PUBLICATION_PLAN_MISMATCH")
    expected_fence_hash = hashlib.sha256(run.fencing_token.encode("utf-8")).hexdigest()
    if str(publication.get("continuousSqlFencingTokenHash") or "") != expected_fence_hash:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_PUBLICATION_FENCED")
    source_boundary = publication.get("sourceBoundary")
    try:
        boundary_batch_id = int(source_boundary.get("batchId", -1)) if isinstance(source_boundary, dict) else -1
        boundary_generation = int(source_boundary.get("runGeneration", -1)) if isinstance(source_boundary, dict) else -1
    except (TypeError, ValueError) as exc:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_SOURCE_BOUNDARY_INVALID") from exc
    if not isinstance(source_boundary, dict) or any((
        source_boundary.get("kind") != "continuous_sql_batch",
        str(source_boundary.get("jobId") or "") != job.id,
        boundary_batch_id != batch_id,
        boundary_generation != generation,
        str(source_boundary.get("planHash") or "") != job.plan_hash,
        str(source_boundary.get("fencingTokenHash") or "") != expected_fence_hash,
    )):
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_SOURCE_BOUNDARY_INVALID")
    source_ranges = publication.get("sourceRanges")
    if not isinstance(source_ranges, list) or source_boundary.get("sourceRanges") != source_ranges:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_SOURCE_OFFSETS_INVALID")
    static_snapshots = publication.get("staticSnapshots")
    if not isinstance(static_snapshots, list) or source_boundary.get("staticSnapshots") != static_snapshots:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_STATIC_BINDING_MISMATCH")
    publication_run_id = str(publication.get("runId") or "").strip()
    if publication_run_id != str(source_boundary.get("runId") or "").strip():
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_PUBLICATION_RUN_ID_INVALID")
    manifest_path = str(publication.get("manifestPath") or "").strip()
    if not manifest_path:
        raise ContinuousSqlPublicationError("CONTINUOUS_SQL_MANIFEST_MISSING")
    iceberg_commit = publication.get("icebergCommit")
    if row_count > 0:
        if not isinstance(iceberg_commit, dict) or iceberg_commit.get("sourceBoundary") != source_boundary:
            raise ContinuousSqlPublicationError("CONTINUOUS_SQL_OUTPUT_COMMIT_INVALID")
    else:
        iceberg_commit = None
    return {
        "batchId": batch_id,
        "generation": generation,
        "rowCount": row_count,
        "sourceRanges": source_ranges,
        "staticSnapshots": static_snapshots,
        "sourceBoundary": source_boundary,
        "publicationRunId": publication_run_id,
        "manifestPath": manifest_path,
        "icebergCommit": iceberg_commit,
        "publishedAt": str(publication.get("publishedAt") or ""),
    }


def parse_display_count(value: Any) -> int:
    digits = "".join(character for character in str(value or "") if character.isdigit())
    return int(digits or 0)
