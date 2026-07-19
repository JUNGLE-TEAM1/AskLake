from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import status
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.application.etl_schedule import has_scheduled_execution
from app.clients.opensearch_client import OpenSearchClient
from app.core.auth_context import ActorContext, require_permission
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models import (
    CatalogDatasetModel,
    ContinuousSqlJobModel,
    DashboardBatchWidgetResult,
    DashboardWidget,
    DashboardWidgetResultModel,
    DatasetFreshnessModel,
    DatasetKafkaPartitionCursorModel,
    DatasetRevisionCommitModel,
    ETLJobModel,
    ETLRunModel,
    PermissionGrantModel,
    RagClassificationRunModel,
    RagColumnRecommendationModel,
    RagDatasetProfileModel,
    RagIndexJobModel,
    RagIndexManifestModel,
    ResourceLockModel,
    SemanticDimensionModel,
    SemanticMetricModel,
    SemanticModelDatasetModel,
    SemanticModelModel,
    SemanticRelationshipModel,
    SqlRunModel,
)
from app.models.catalog_deletion import CatalogDatasetDeletionModel
from app.repositories.audit_repository import add_audit_event
from app.repositories.catalog_deletion_repository import CatalogDeletionRepository
from app.repositories.catalog_repository import CatalogRepository, dataset_model_to_payload
from app.schemas.catalog import (
    CatalogDatasetDeletionAcceptedResponse,
    CatalogDatasetDeletionArtifact,
    CatalogDatasetDeletionBlocker,
    CatalogDatasetDeletionImpact,
    CatalogDatasetDeletionStatusResponse,
    CatalogDatasetResponse,
)
from app.schemas.common import ErrorCode
from app.schemas.iceberg import IcebergWriterTarget
from app.services.clickhouse_client import ClickHouseClient, qualified_clickhouse_table
from app.services.governance_enforcement import require_governed_access
from app.services.iceberg_writer_service import IcebergWriterService
from app.services.lake_storage_service import LocalLakeStorageService
from app.services.object_storage import object_storage_runtime
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


TERMINAL_RAG_STATUSES = {"canceled", "cancelled", "completed", "failed", "ready", "rejected", "success", "succeeded"}
ACTIVE_RUN_STATUSES = {"queued", "running", "starting", "submitted"}


class CatalogDatasetDeletionService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.catalog_repository = CatalogRepository(db)
        self.deletion_repository = CatalogDeletionRepository(db)

    def impact(self, dataset_id: str, actor: ActorContext) -> CatalogDatasetDeletionImpact:
        dataset, payload = self._authorized_dataset(dataset_id, actor, api_suffix="deletion-impact", method="GET")
        return build_deletion_impact(self.db, dataset, payload)

    def request(self, dataset_id: str, actor: ActorContext, *, confirm_name: str) -> CatalogDatasetDeletionAcceptedResponse:
        dataset, _payload = self._authorized_dataset(dataset_id, actor, method="DELETE")
        if confirm_name != dataset.name:
            raise ApiError(
                "CATALOG_DATASET_DELETE_CONFIRMATION_MISMATCH",
                "Dataset name confirmation does not match.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"datasetId": dataset_id},
            )
        self._raise_if_existing_deletion(dataset_id)
        locked_payload = self.catalog_repository.get_dataset_payload_for_update(dataset_id)
        if locked_payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset not found", status.HTTP_404_NOT_FOUND)
        self._raise_if_existing_deletion(dataset_id)
        locked_dataset = CatalogDatasetResponse.model_validate(locked_payload)
        impact = build_deletion_impact(self.db, locked_dataset, locked_payload)
        if impact.blockers:
            raise ApiError(
                "CATALOG_DATASET_DELETE_BLOCKED",
                "Dataset deletion is blocked by active or dependent resources.",
                status.HTTP_409_CONFLICT,
                impact.model_dump(by_alias=True),
            )
        row = self.deletion_repository.create_or_retry(
            actor_snapshot=actor_snapshot(actor),
            dataset_id=locked_dataset.id,
            dataset_name=locked_dataset.name,
            dataset_snapshot=locked_payload,
            impact_snapshot=impact.model_dump(by_alias=True),
        )
        return CatalogDatasetDeletionAcceptedResponse(
            dataset_id=locked_dataset.id,
            deletion_id=row.id,
            status=row.status,
        )

    def _raise_if_existing_deletion(self, dataset_id: str) -> None:
        existing = self.deletion_repository.latest_for_dataset(dataset_id)
        if existing is None or existing.status == "failed":
            return
        raise ApiError(
            "CATALOG_DATASET_DELETION_EXISTS",
            "A deletion request already exists for this dataset.",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "deletionId": existing.id, "status": existing.status},
        )

    def status(self, deletion_id: str, actor: ActorContext) -> CatalogDatasetDeletionStatusResponse:
        row = self.deletion_repository.get(deletion_id)
        if row is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset deletion not found", status.HTTP_404_NOT_FOUND)
        request_actor = actor_from_snapshot(row.actor_snapshot)
        if not actor.is_admin and not actor_matches(actor, request_actor):
            raise ApiError(ErrorCode.FORBIDDEN, "Dataset deletion status is not visible to this actor", status.HTTP_403_FORBIDDEN)
        return deletion_status_response(row)

    def _authorized_dataset(
        self,
        dataset_id: str,
        actor: ActorContext,
        *,
        api_suffix: str | None = None,
        method: str,
    ) -> tuple[CatalogDatasetResponse, dict[str, Any]]:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset not found", status.HTTP_404_NOT_FOUND)
        dataset = dataset_with_persisted_permission_grants(
            self.db,
            CatalogDatasetResponse.model_validate(payload),
        )
        api_path = f"/api/catalog/datasets/{dataset_id}" + (f"/{api_suffix}" if api_suffix else "")
        require_governed_access(
            self.db,
            actor,
            action="delete",
            api_path=api_path,
            http_method=method,
            metadata={"owner": dataset.owner},
            resource_id=dataset.id,
            resource_name=dataset.name,
            resource_type="dataset",
        )
        require_permission(
            actor,
            "delete",
            owner=dataset.owner,
            grants=dataset.permission_grants,
            resource_label="dataset",
        )
        return dataset, payload


def build_deletion_impact(
    db: Session,
    dataset: CatalogDatasetResponse,
    payload: dict[str, Any],
) -> CatalogDatasetDeletionImpact:
    blockers: list[CatalogDatasetDeletionBlocker] = []
    artifacts: list[CatalogDatasetDeletionArtifact] = []
    retained = ["audit events", "completed ETL/SQL run history", "stopped producer job definitions", "deletion receipt"]
    add_workload_blockers(db, dataset.id, blockers)
    add_dependency_blockers(db, dataset.id, payload, blockers)
    rag_jobs = add_rag_blockers(db, dataset.id, blockers)
    add_dataset_artifacts(artifacts, payload)
    add_rag_artifacts(db, dataset.id, rag_jobs, artifacts)
    add_artifact_ownership_blockers(dataset, artifacts, blockers)

    unique_blockers = unique_items(blockers, lambda item: (item.resource_type, item.resource_id, item.reason))
    unique_artifacts = unique_items(artifacts, lambda item: (item.kind, item.location))
    size_bytes = sum(int(run.storage_size_bytes or 0) for run in dataset.materialization_runs if run.storage_location)
    if not size_bytes:
        size_bytes = int(dataset.storage_size_bytes or 0)
    return CatalogDatasetDeletionImpact(
        artifacts=unique_artifacts,
        blockers=unique_blockers,
        can_delete=not unique_blockers,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        estimated_size_bytes=size_bytes,
        retained_resources=retained,
    )


def add_workload_blockers(
    db: Session,
    dataset_id: str,
    blockers: list[CatalogDatasetDeletionBlocker],
) -> None:
    producer_jobs = list(db.scalars(select(ETLJobModel).where(ETLJobModel.dataset_id == dataset_id)))
    for job in producer_jobs:
        active_run = db.scalar(
            select(ETLRunModel.run_id).where(
                ETLRunModel.job_id == job.id,
                ETLRunModel.status.in_(ACTIVE_RUN_STATUSES),
            ).limit(1)
        )
        if active_run:
            blockers.append(blocker("etl_run", active_run, job.name, "생성 작업이 실행 중입니다."))
        if job.execution_mode == "continuous" and str(job.status).casefold() != "stopped":
            blockers.append(blocker("etl_job", job.id, job.name, "Continuous 생성 작업을 먼저 중지해야 합니다."))
        if has_scheduled_execution(job):
            blockers.append(blocker("etl_job", job.id, job.name, "예약 실행을 먼저 중지해야 합니다."))

    producer_job_ids = {item.id for item in producer_jobs}
    for job in db.scalars(select(ETLJobModel)):
        if job.id in producer_job_ids:
            continue
        if nested_contains(job.source_config, dataset_id) or nested_contains(job.sql_recipe, dataset_id):
            blockers.append(blocker("etl_job", job.id, job.name, "이 Job이 데이터셋을 source로 사용합니다."))

    for job in db.scalars(select(ContinuousSqlJobModel)):
        is_output = job.output_dataset_id == dataset_id
        uses_as_source = nested_contains(job.relation_bindings, dataset_id)
        if not is_output and not uses_as_source:
            continue
        active = job.desired_state != "stopped" or job.observed_state not in {"stopped", "failed"}
        if is_output and active:
            blockers.append(blocker("continuous_sql_job", job.id, job.name, "Continuous SQL 작업을 먼저 중지해야 합니다."))
        if uses_as_source:
            blockers.append(blocker("continuous_sql_job", job.id, job.name, "Continuous SQL Job이 데이터셋을 source로 참조합니다."))

    for run in db.scalars(select(SqlRunModel)):
        run_status = str((run.payload or {}).get("status") or "").casefold()
        if run_status in ACTIVE_RUN_STATUSES and (run.dataset_id == dataset_id or nested_contains(run.payload, dataset_id)):
            blockers.append(blocker("sql_run", run.id, run.id, "SQL 실행이 데이터셋을 사용 중입니다."))


def add_dependency_blockers(
    db: Session,
    dataset_id: str,
    payload: dict[str, Any],
    blockers: list[CatalogDatasetDeletionBlocker],
) -> None:
    for widget in db.scalars(select(DashboardWidget).where(DashboardWidget.dataset_id == dataset_id)):
        blockers.append(blocker("dashboard_widget", widget.id, widget.title or widget.id, "Dashboard widget이 데이터셋을 참조합니다."))

    semantic_model_ids: set[str] = set()
    semantic_model_ids.update(db.scalars(select(SemanticModelDatasetModel.model_id).where(SemanticModelDatasetModel.dataset_id == dataset_id)))
    semantic_model_ids.update(db.scalars(select(SemanticMetricModel.model_id).where(SemanticMetricModel.dataset_id == dataset_id)))
    semantic_model_ids.update(db.scalars(select(SemanticDimensionModel.model_id).where(SemanticDimensionModel.dataset_id == dataset_id)))
    semantic_model_ids.update(db.scalars(select(SemanticRelationshipModel.model_id).where(or_(
        SemanticRelationshipModel.from_dataset_id == dataset_id,
        SemanticRelationshipModel.to_dataset_id == dataset_id,
    ))))
    for model_id in sorted(semantic_model_ids):
        model = db.get(SemanticModelModel, model_id)
        blockers.append(blocker("semantic_model", model_id, model.name if model else model_id, "Semantic model이 데이터셋을 참조합니다."))

    catalog_datasets = list(db.scalars(select(CatalogDatasetModel)))
    by_id = {str(item.id): item for item in catalog_datasets}
    by_name = {str(item.name): item for item in catalog_datasets if item.name}
    downstream_ids: set[str] = set()
    for item in payload.get("downstream") or []:
        downstream = by_id.get(str(item)) or by_name.get(str(item))
        if downstream is not None and downstream.id != dataset_id:
            downstream_ids.add(str(downstream.id))
    dataset_name = str(payload.get("name") or "")
    for other in catalog_datasets:
        if other.id == dataset_id:
            continue
        other_payload = dataset_model_to_payload(other)
        upstream_references = {str(item) for item in other_payload.get("upstream") or []}
        if dataset_id in upstream_references or (dataset_name and dataset_name in upstream_references):
            downstream_ids.add(other.id)
    for downstream_id in sorted(downstream_ids):
        downstream = db.get(CatalogDatasetModel, downstream_id)
        blockers.append(blocker("catalog_dataset", downstream_id, downstream.name if downstream else downstream_id, "downstream Dataset lineage가 남아 있습니다."))


def add_rag_blockers(
    db: Session,
    dataset_id: str,
    blockers: list[CatalogDatasetDeletionBlocker],
) -> list[RagIndexJobModel]:
    for run in db.scalars(select(RagClassificationRunModel).where(RagClassificationRunModel.dataset_id == dataset_id)):
        if str(run.status).casefold() not in TERMINAL_RAG_STATUSES:
            blockers.append(blocker("rag_classification", run.id, run.id, "RAG 분류 작업이 진행 중입니다."))
    rag_jobs = list(db.scalars(select(RagIndexJobModel).where(RagIndexJobModel.dataset_id == dataset_id)))
    for job in rag_jobs:
        if str(job.status).casefold() not in TERMINAL_RAG_STATUSES:
            blockers.append(blocker("rag_index_job", job.id, job.id, "RAG 색인 작업이 진행 중입니다."))
    return rag_jobs


def add_rag_artifacts(
    db: Session,
    dataset_id: str,
    rag_jobs: list[RagIndexJobModel],
    artifacts: list[CatalogDatasetDeletionArtifact],
) -> None:
    for manifest in db.scalars(select(RagIndexManifestModel).where(RagIndexManifestModel.dataset_id == dataset_id)):
        artifacts.append(CatalogDatasetDeletionArtifact(kind="opensearch_index", location=manifest.index_name))
    for job in rag_jobs:
        for index_name in (job.target_index, job.validated_index, job.activation_target_index, job.activation_previous_index):
            if index_name:
                artifacts.append(CatalogDatasetDeletionArtifact(kind="opensearch_index", location=index_name))
        for kind, location in (("rag_parent_table", job.parent_table), ("rag_chunk_table", job.chunk_table), ("rag_checkpoint", job.checkpoint_path)):
            if location:
                artifacts.append(CatalogDatasetDeletionArtifact(kind=kind, location=location))


def add_artifact_ownership_blockers(
    dataset: CatalogDatasetResponse,
    artifacts: list[CatalogDatasetDeletionArtifact],
    blockers: list[CatalogDatasetDeletionBlocker],
) -> None:
    for artifact in artifacts:
        if artifact.kind in {"storage", "rag_checkpoint"} and not is_managed_storage_location(artifact.location, dataset):
            blockers.append(blocker("storage", artifact.location, artifact.location, "AskLake 관리 경로임을 확인할 수 없습니다."))
        if artifact.kind in {"iceberg_table", "rag_parent_table", "rag_chunk_table"}:
            table_parts = [item.strip('`" ') for item in artifact.location.split(".") if item.strip('`" ')]
            if len(table_parts) == 3 and table_parts[0] != settings.trino_catalog:
                blockers.append(blocker("storage", artifact.location, artifact.location, "AskLake 관리 Iceberg catalog가 아닙니다."))
        if artifact.kind == "clickhouse_table" and artifact.location.split(".", 1)[0].strip('`" ') != settings.clickhouse_database:
            blockers.append(blocker("storage", artifact.location, artifact.location, "AskLake 관리 ClickHouse database가 아닙니다."))


class CatalogPhysicalPurger:
    def purge(self, db: Session, row: CatalogDatasetDeletionModel) -> None:
        payload = row.dataset_snapshot or {}
        dataset = CatalogDatasetResponse.model_validate(payload)

        impact = CatalogDatasetDeletionImpact.model_validate(row.impact_snapshot)
        for artifact in impact.artifacts:
            if artifact.kind == "storage":
                self._purge_storage(artifact.location, dataset)
            elif artifact.kind == "iceberg_table":
                self._drop_rag_table(artifact.location)
            elif artifact.kind == "clickhouse_table":
                self._drop_clickhouse_artifact(artifact.location)
            elif artifact.kind == "opensearch_index":
                self._delete_opensearch_index(artifact.location)
            elif artifact.kind in {"rag_parent_table", "rag_chunk_table"}:
                self._drop_rag_table(artifact.location)
            elif artifact.kind == "rag_checkpoint":
                self._purge_storage(artifact.location, dataset)

    def _drop_iceberg_table(self, value: dict[str, Any]) -> None:
        if str(value.get("catalog") or "") != settings.trino_catalog:
            raise RuntimeError("CATALOG_DATASET_UNMANAGED_ICEBERG_TABLE")
        target = IcebergWriterTarget(
            catalog=str(value["catalog"]),
            namespace=str(value.get("schema") or ""),
            table=str(value.get("table") or ""),
            write_mode="replace",
            partition_columns=[str(item) for item in value.get("partitionColumns") or []],
        )
        IcebergWriterService().drop_table(target)

    def _drop_clickhouse_table(self, value: dict[str, Any]) -> None:
        database = str(value.get("database") or "")
        table = str(value.get("table") or "")
        if database != settings.clickhouse_database:
            raise RuntimeError("CATALOG_DATASET_UNMANAGED_CLICKHOUSE_TABLE")
        client = ClickHouseClient()
        try:
            client.execute(f"DROP TABLE IF EXISTS {qualified_clickhouse_table(database, table)}", database=database)
        finally:
            client.close()

    def _drop_clickhouse_artifact(self, location: str) -> None:
        database, separator, table = location.partition(".")
        if not separator or not database or not table:
            raise RuntimeError("CATALOG_DATASET_INVALID_CLICKHOUSE_TABLE")
        self._drop_clickhouse_table({"database": database, "table": table})

    def _drop_rag_table(self, location: str) -> None:
        parts = [item.strip('`" ') for item in location.split(".") if item.strip('`" ')]
        if len(parts) == 3:
            catalog, namespace, table = parts
        elif len(parts) == 2:
            catalog, namespace, table = settings.trino_catalog, parts[0], parts[1]
        else:
            catalog, namespace, table = settings.trino_catalog, settings.trino_schema, parts[0] if parts else ""
        self._drop_iceberg_table({"catalog": catalog, "schema": namespace, "table": table, "format": "iceberg"})

    def _purge_storage(self, location: str, dataset: CatalogDatasetResponse) -> None:
        if not is_managed_storage_location(location, dataset):
            raise RuntimeError("CATALOG_DATASET_UNMANAGED_STORAGE")
        parsed = urlparse(location.replace("s3a://", "s3://", 1))
        if parsed.scheme == "s3":
            delete_s3_prefix(parsed.netloc, managed_storage_prefix(parsed.path.lstrip("/"), dataset))
            return
        local_root = LocalLakeStorageService().storage_root.resolve()
        path = Path(location).resolve()
        target = next(
            (
                candidate
                for candidate in (path, *path.parents)
                if candidate != local_root and is_dataset_scope_segment(candidate.name, dataset)
            ),
            None,
        )
        if target is None or not target.is_relative_to(local_root):
            raise RuntimeError("CATALOG_DATASET_UNMANAGED_STORAGE")
        if target.exists():
            shutil.rmtree(target) if target.is_dir() else target.unlink()

    def _delete_opensearch_index(self, index_name: str) -> None:
        if not settings.opensearch_base_url:
            raise RuntimeError("OPENSEARCH_BASE_URL is not configured")
        try:
            OpenSearchClient(settings).delete_index(index_name)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise


def process_catalog_dataset_deletion_by_id(deletion_id: str) -> None:
    with SessionLocal() as db:
        row = CatalogDeletionRepository(db).claim(deletion_id)
        if row is not None:
            process_claimed_deletion(db, row)


def process_next_catalog_dataset_deletion() -> bool:
    with SessionLocal() as db:
        row = CatalogDeletionRepository(db).claim_next()
        if row is None:
            return False
        process_claimed_deletion(db, row)
        return True


def process_claimed_deletion(
    db: Session,
    row: CatalogDatasetDeletionModel,
    *,
    purger: CatalogPhysicalPurger | None = None,
) -> None:
    repository = CatalogDeletionRepository(db)
    try:
        dataset_model = db.get(CatalogDatasetModel, row.dataset_id)
        if dataset_model is None:
            raise RuntimeError("CATALOG_DATASET_NOT_FOUND_DURING_DELETE")
        fresh_payload = dataset_model_to_payload(dataset_model)
        dataset = CatalogDatasetResponse.model_validate(fresh_payload)
        fresh_impact = build_deletion_impact(db, dataset, fresh_payload)
        if fresh_impact.blockers:
            raise RuntimeError("CATALOG_DATASET_DELETE_BLOCKED")
        row.dataset_snapshot = fresh_payload
        row.impact_snapshot = fresh_impact.model_dump(by_alias=True)
        repository.update_status(row, "purging", commit=False)
        (purger or CatalogPhysicalPurger()).purge(db, row)
        repository.update_status(row, "metadata_cleanup", commit=False)
        delete_dataset_metadata(db, row.dataset_id)
        add_audit_event(
            db,
            action="catalog.dataset.deleted",
            actor=actor_from_snapshot(row.actor_snapshot),
            api_path=f"/api/catalog/datasets/{row.dataset_id}",
            http_method="DELETE",
            metadata={"deletionId": row.id, "impact": row.impact_snapshot},
            result="success",
            status_code=status.HTTP_200_OK,
            target_id=row.dataset_id,
            target_name=row.dataset_name,
            target_type="dataset",
        )
        repository.update_status(row, "succeeded", commit=False)
        db.commit()
    except Exception as exc:
        db.rollback()
        failed = db.get(CatalogDatasetDeletionModel, row.id)
        if failed is not None:
            CatalogDeletionRepository(db).update_status(
                failed,
                "failed",
                error_code=error_code(exc),
                error_message=str(exc)[:1000] or type(exc).__name__,
            )


def delete_dataset_metadata(db: Session, dataset_id: str) -> None:
    for model in (DashboardBatchWidgetResult, DashboardWidgetResultModel, DatasetFreshnessModel, DatasetRevisionCommitModel, DatasetKafkaPartitionCursorModel):
        db.execute(delete(model).where(model.dataset_id == dataset_id))
    for model in (RagColumnRecommendationModel, RagClassificationRunModel, RagIndexJobModel, RagIndexManifestModel):
        db.execute(delete(model).where(model.dataset_id == dataset_id))
    db.execute(delete(RagDatasetProfileModel).where(RagDatasetProfileModel.dataset_id == dataset_id))
    db.execute(delete(PermissionGrantModel).where(
        PermissionGrantModel.resource_type == "dataset",
        PermissionGrantModel.resource_id == dataset_id,
    ))
    db.execute(delete(ResourceLockModel).where(
        ResourceLockModel.resource_type == "dataset",
        ResourceLockModel.resource_id == dataset_id,
    ))
    db.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id == dataset_id))
    db.flush()


def add_dataset_artifacts(artifacts: list[CatalogDatasetDeletionArtifact], payload: dict[str, Any]) -> None:
    query_table = payload.get("queryEngineTable")
    if isinstance(query_table, dict) and query_table.get("table"):
        artifacts.append(CatalogDatasetDeletionArtifact(
            kind="iceberg_table",
            location=".".join(str(query_table.get(key) or "") for key in ("catalog", "schema", "table")),
        ))
    clickhouse_table = payload.get("clickhouseTable")
    if isinstance(clickhouse_table, dict) and clickhouse_table.get("table"):
        artifacts.append(CatalogDatasetDeletionArtifact(
            kind="clickhouse_table",
            location=f"{clickhouse_table.get('database')}.{clickhouse_table.get('table')}",
        ))
    if not (isinstance(query_table, dict) and query_table.get("format") == "iceberg") and payload.get("storageLocation"):
        artifacts.append(CatalogDatasetDeletionArtifact(kind="storage", location=str(payload["storageLocation"])))
    for run in payload.get("materializationRuns") or []:
        if not isinstance(run, dict):
            continue
        run_table = run.get("queryEngineTable")
        if isinstance(run_table, dict) and run_table.get("format") == "iceberg" and run_table.get("table"):
            artifacts.append(CatalogDatasetDeletionArtifact(
                kind="iceberg_table",
                location=".".join(str(run_table.get(key) or "") for key in ("catalog", "schema", "table")),
            ))
        elif run.get("storageLocation"):
            artifacts.append(CatalogDatasetDeletionArtifact(kind="storage", location=str(run["storageLocation"])))


def is_managed_storage_location(location: str, dataset: CatalogDatasetResponse) -> bool:
    normalized = location.replace("s3a://", "s3://", 1)
    parsed = urlparse(normalized)
    path_segments = [item for item in parsed.path.split("/") if item]
    token_match = any(is_dataset_scope_segment(item, dataset) for item in path_segments)
    if parsed.scheme == "s3":
        rag_staging = settings.rag_staging_base_path.replace("s3a://", "s3://", 1).rstrip("/")
        return token_match and (
            parsed.netloc == settings.asklake_spark_output_bucket
            or normalized.rstrip("/").startswith(rag_staging + "/")
        )
    if parsed.scheme:
        return False
    try:
        root = LocalLakeStorageService().storage_root.resolve()
        path = Path(location).resolve()
        return path.is_relative_to(root) and any(is_dataset_scope_segment(item, dataset) for item in path.parts)
    except (OSError, RuntimeError, ValueError):
        return False


def delete_s3_prefix(bucket: str, key: str) -> None:
    import boto3

    runtime = object_storage_runtime()
    client = boto3.client("s3", **runtime.boto3_kwargs())
    continuation: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": key}
        if continuation:
            kwargs["ContinuationToken"] = continuation
        response = client.list_objects_v2(**kwargs)
        objects = [{"Key": item["Key"]} for item in response.get("Contents") or [] if item.get("Key")]
        if objects:
            client.delete_objects(Bucket=bucket, Delete={"Objects": objects, "Quiet": True})
        if not response.get("IsTruncated"):
            return
        continuation = str(response.get("NextContinuationToken") or "") or None


def managed_storage_prefix(key: str, dataset: CatalogDatasetResponse) -> str:
    segments = [item for item in key.split("/") if item]
    for index, segment in enumerate(segments):
        if is_dataset_scope_segment(segment, dataset):
            return "/".join(segments[:index + 1]) + "/"
    raise RuntimeError("CATALOG_DATASET_UNMANAGED_STORAGE")


def is_dataset_scope_segment(value: str, dataset: CatalogDatasetResponse) -> bool:
    normalized = value.casefold()
    tokens = {dataset.id.casefold(), dataset.name.casefold()}
    return normalized in tokens or normalized in {f"dataset_id={token}" for token in tokens}


def blocker(resource_type: str, resource_id: str, resource_name: str, reason: str) -> CatalogDatasetDeletionBlocker:
    return CatalogDatasetDeletionBlocker(
        resource_type=resource_type,
        resource_id=str(resource_id),
        resource_name=str(resource_name),
        reason=reason,
    )


def nested_contains(value: object, expected: str) -> bool:
    if isinstance(value, dict):
        return any(nested_contains(item, expected) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(nested_contains(item, expected) for item in value)
    return str(value or "") == expected


def unique_items(items: list[Any], key: Any) -> list[Any]:
    seen: set[object] = set()
    result: list[Any] = []
    for item in items:
        item_key = key(item)
        if item_key in seen:
            continue
        seen.add(item_key)
        result.append(item)
    return result


def actor_snapshot(actor: ActorContext) -> dict[str, object]:
    return {
        "email": actor.email,
        "groups": list(actor.groups),
        "id": actor.id,
        "name": actor.name,
        "role": actor.role,
    }


def actor_from_snapshot(value: dict[str, Any]) -> ActorContext:
    return ActorContext(
        email=str(value.get("email") or "") or None,
        groups=tuple(str(item) for item in value.get("groups") or []),
        id=str(value.get("id") or "") or None,
        name=str(value.get("name") or "anonymous"),
        role=str(value.get("role") or "viewer"),
    )


def actor_matches(left: ActorContext, right: ActorContext) -> bool:
    return bool(
        (left.id and right.id and left.id == right.id)
        or (left.email and right.email and left.email == right.email)
        or left.name == right.name
    )


def deletion_status_response(row: CatalogDatasetDeletionModel) -> CatalogDatasetDeletionStatusResponse:
    return CatalogDatasetDeletionStatusResponse(
        created_at=row.created_at.isoformat(),
        dataset_id=row.dataset_id,
        dataset_name=row.dataset_name,
        deletion_id=row.id,
        error_code=row.error_code,
        error_message=row.error_message,
        status=row.status,
        updated_at=row.updated_at.isoformat(),
    )


def error_code(exc: Exception) -> str:
    value = getattr(exc, "code", None)
    if value:
        return str(value)
    message = str(exc).strip()
    if message and message.upper() == message and " " not in message:
        return message[:120]
    return "CATALOG_DATASET_DELETE_FAILED"
