from typing import Any

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel

_schema_ready_bind_ids: set[int] = set()


class CatalogRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_dataset_models(self) -> list[CatalogDatasetModel]:
        ensure_catalog_schema(self.db)
        result = self.db.execute(
            select(CatalogDatasetModel).order_by(
                CatalogDatasetModel.updated_at.desc(),
                CatalogDatasetModel.id.asc(),
            )
        )
        return list(result.scalars().all())

    def get_dataset_model(self, dataset_id: str) -> CatalogDatasetModel | None:
        ensure_catalog_schema(self.db)
        return self.db.get(CatalogDatasetModel, dataset_id)

    def get_dataset_model_for_update(
        self,
        dataset_id: str,
        *,
        allow_deletion_fence: bool = False,
    ) -> CatalogDatasetModel | None:
        ensure_catalog_schema(self.db)
        model = self.db.scalar(
            select(CatalogDatasetModel)
            .where(CatalogDatasetModel.id == dataset_id)
            .with_for_update()
        )
        if not allow_deletion_fence:
            from app.repositories.catalog_deletion_repository import ensure_catalog_publication_allowed

            ensure_catalog_publication_allowed(self.db, dataset_id)
        return model

    def get_dataset_payload(self, dataset_id: str) -> dict[str, Any] | None:
        model = self.get_dataset_model(dataset_id)
        if model is None:
            return None
        self._raise_if_deletion_in_progress(dataset_id)
        return dataset_model_to_payload(model)

    def get_dataset_payload_for_update(self, dataset_id: str) -> dict[str, Any] | None:
        model = self.get_dataset_model_for_update(dataset_id, allow_deletion_fence=True)
        return dataset_model_to_payload(model) if model else None

    def get_dataset_payload_by_name(self, dataset_name: str) -> dict[str, Any] | None:
        ensure_catalog_schema(self.db)
        model = self.db.scalar(
            select(CatalogDatasetModel).where(CatalogDatasetModel.name == dataset_name)
        )
        return dataset_model_to_payload(model) if model else None

    def get_lineage_payload(self, dataset_id: str) -> dict[str, Any] | None:
        payload = self.get_dataset_payload(dataset_id)
        lineage_graph = payload.get("lineageGraph") if payload else None
        return lineage_graph if isinstance(lineage_graph, dict) else None

    def save_dataset_payload(
        self,
        payload: dict[str, Any],
        *,
        commit: bool = True,
    ) -> dict[str, Any]:
        ensure_catalog_schema(self.db)
        dataset_id = str(payload["id"])
        model = self.get_dataset_model_for_update(dataset_id)

        if model is None:
            self.db.add(CatalogDatasetModel(id=dataset_id, **dataset_payload_to_model_values(payload)))
        else:
            for key, value in dataset_payload_to_model_values(payload).items():
                setattr(model, key, value)

        self.db.flush()
        if commit:
            self.db.commit()
        return payload

    def _raise_if_deletion_in_progress(self, dataset_id: str) -> None:
        from app.core.errors import ApiError
        from app.repositories.catalog_deletion_repository import ACTIVE_DELETION_STATUSES, CatalogDeletionRepository

        deletion = CatalogDeletionRepository(self.db).latest_for_dataset(dataset_id)
        if deletion is not None and deletion.status in ACTIVE_DELETION_STATUSES:
            raise ApiError(
                "DATASET_DELETION_IN_PROGRESS",
                "Dataset deletion is in progress.",
                409,
                {"datasetId": dataset_id, "deletionId": deletion.id, "status": deletion.status},
            )


def ensure_catalog_schema(db: Session) -> None:
    bind = db.get_bind()
    bind_key = id(bind)
    if bind_key in _schema_ready_bind_ids:
        return

    with bind.begin() as connection:
        inspector = inspect(connection)
        if "catalog_datasets" not in inspector.get_table_names():
            CatalogDatasetModel.__table__.create(bind=connection)

        existing_columns = {column["name"] for column in inspector.get_columns("catalog_datasets")}
        column_defs = {
            "payload": "JSONB",
            "name": "VARCHAR(255)",
            "description": "TEXT",
            "owner": "VARCHAR(255)",
            "layer": "VARCHAR(32)",
            "status": "VARCHAR(64)",
            "freshness": "VARCHAR(64)",
            "source": "VARCHAR(255)",
            "producer_job_id": "VARCHAR(160)",
            "producer_job_kind": "VARCHAR(64)",
            "execution_mode": "VARCHAR(32)",
            "source_kind": "VARCHAR(64)",
            "relation_mode": "VARCHAR(32)",
            "runtime_status": "VARCHAR(64)",
            "source_manifest": "JSON",
            "rows": "VARCHAR(120)",
            "size": "VARCHAR(120)",
            "quality": "VARCHAR(255)",
            "last_updated": "VARCHAR(64)",
            "next_refresh": "VARCHAR(255)",
            "rag": "BOOLEAN",
            "tags": "JSON",
            "schema_json": "JSON",
            "sample_rows": "JSON",
            "upstream": "JSON",
            "downstream": "JSON",
            "lineage_graph": "JSON",
        }
        for column_name, column_type in column_defs.items():
            if column_name not in existing_columns:
                connection.execute(text(f"ALTER TABLE catalog_datasets ADD COLUMN {column_name} {column_type}"))

    _schema_ready_bind_ids.add(bind_key)


def dataset_model_to_payload(model: CatalogDatasetModel) -> dict[str, Any]:
    payload = dict(model.payload or {
        "description": model.description or "",
        "downstream": model.downstream or [],
        "freshness": model.freshness or "latest",
        "id": model.id,
        "layer": model.layer or "RAW",
        "lastUpdated": model.last_updated or "",
        "lineageGraph": model.lineage_graph,
        "name": model.name or model.id,
        "nextRefresh": model.next_refresh or "-",
        "owner": model.owner or "",
        "quality": model.quality or "확인 대기",
        "rag": bool(model.rag),
        "rows": model.rows or "0",
        "sampleRows": model.sample_rows or [],
        "schema": model.schema_json or [],
        "size": model.size or "Pending",
        "source": model.source or "",
        "sourceManifest": model.source_manifest,
        "status": model.status or "available",
        "tags": model.tags or [],
        "upstream": model.upstream or [],
    })
    authoritative_metadata = {
        "producerJobId": model.producer_job_id,
        "producerJobKind": model.producer_job_kind,
        "executionMode": model.execution_mode,
        "sourceKind": model.source_kind,
        "relationMode": model.relation_mode,
        "runtimeStatus": model.runtime_status,
    }
    for key, value in authoritative_metadata.items():
        if value is not None:
            payload[key] = value
    return normalize_dataset_payload(payload)


def normalize_dataset_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized_payload = dict(payload)
    # RAG is no longer a product/runtime capability. Older durable Catalog
    # payloads may omit this former field, so retain a harmless compatibility
    # default instead of making the whole Catalog list fail validation.
    normalized_payload.setdefault("rag", False)
    physical_bindings = normalized_payload.get("physicalBindings")
    if not isinstance(physical_bindings, list):
        physical_bindings = []
        clickhouse = normalized_payload.get("clickhouseTable")
        if isinstance(clickhouse, dict) and clickhouse.get("database") and clickhouse.get("table"):
            physical_bindings.append({
                "role": "serving", "engine": "clickhouse", "status": "active",
                "bindingEpoch": int(normalized_payload.get("bindingEpoch") or 0),
                "versionId": normalized_payload.get("activeServingVersionId"),
                "database": clickhouse["database"], "table": clickhouse["table"],
            })
        query_engine = normalized_payload.get("queryEngineTable")
        if isinstance(query_engine, dict) and query_engine.get("catalog") and query_engine.get("schema") and query_engine.get("table"):
            physical_bindings.append({
                "role": "archive", "engine": "trino", "status": "active",
                "bindingEpoch": int(normalized_payload.get("bindingEpoch") or 0),
                "catalog": query_engine["catalog"], "schema": query_engine["schema"],
                "table": query_engine["table"],
                "snapshotId": normalized_payload.get("icebergSnapshotId"),
            })
    normalized_payload["physicalBindings"] = physical_bindings
    owner = str(normalized_payload.get("owner") or "")
    normalized_payload["permissionGrants"] = normalized_payload.get("permissionGrants") or permission_grants_from_roles(
        owner,
        default_actions=["view", "query"],
    )
    normalized_payload["permissions"] = normalized_payload.get("permissions") or resource_permissions(can_query=True)
    materialization_runs = normalized_payload.get("materializationRuns")
    normalized_payload["materializationRuns"] = (
        normalize_materialization_runs(materialization_runs)
        if isinstance(materialization_runs, list)
        else []
    )
    return normalized_payload


def normalize_materialization_runs(materialization_runs: list[Any]) -> list[dict[str, Any]]:
    normalized_runs: list[dict[str, Any]] = []
    for run in materialization_runs:
        if not isinstance(run, dict):
            continue
        normalized_run = dict(run)
        if normalized_run.get("sourceKind") not in {"etl", "sql", "kafka", "continuous_sql"}:
            normalized_run["sourceKind"] = "etl"
        if normalized_run.get("materializationMode") not in {"snapshot", "delta"}:
            normalized_run["materializationMode"] = "delta" if normalized_run["sourceKind"] == "kafka" else "snapshot"
        normalized_runs.append(normalized_run)
    return normalized_runs


def dataset_payload_to_model_values(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "payload": payload,
        "name": payload.get("name"),
        "description": payload.get("description"),
        "owner": payload.get("owner"),
        "layer": payload.get("layer"),
        "status": payload.get("status"),
        "freshness": payload.get("freshness"),
        "source": payload.get("source"),
        "producer_job_id": payload.get("producerJobId") or payload.get("producer_job_id"),
        "producer_job_kind": payload.get("producerJobKind") or payload.get("producer_job_kind"),
        "execution_mode": payload.get("executionMode") or payload.get("execution_mode"),
        "source_kind": payload.get("sourceKind") or payload.get("source_kind"),
        "relation_mode": payload.get("relationMode") or payload.get("relation_mode"),
        "runtime_status": payload.get("runtimeStatus") or payload.get("runtime_status"),
        "source_manifest": payload.get("sourceManifest") or payload.get("source_manifest"),
        "rows": payload.get("rows"),
        "size": payload.get("size"),
        "quality": payload.get("quality"),
        "last_updated": payload.get("lastUpdated"),
        "next_refresh": payload.get("nextRefresh"),
        "rag": payload.get("rag"),
        "tags": payload.get("tags"),
        "schema_json": payload.get("schema"),
        "sample_rows": payload.get("sampleRows"),
        "upstream": payload.get("upstream"),
        "downstream": payload.get("downstream"),
        "lineage_graph": payload.get("lineageGraph"),
    }
