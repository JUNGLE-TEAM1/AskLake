from uuid import uuid4
import re

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse, CreateDerivedDatasetRequest, QueryEngineTableRef
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoMaterializationRunResponse, TrinoQueryRunResponse
from app.services.trino_client import TrinoClient
from app.services.trino_materialization import build_trino_materialization_statement
from app.services.trino_query_run_service import trino_status


class TrinoMaterializationService:
    def __init__(self, repository: SqlRepository, catalog_repository: CatalogRepository, runtime_settings: Settings | None = None) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = TrinoClient(
            self.settings,
            username=self.settings.trino_materializer_username,
            password=self.settings.trino_materializer_password,
        )

    def submit(self, source_run_id: str, request: CreateDerivedDatasetRequest, actor: ActorContext) -> TrinoMaterializationRunResponse:
        if not self.settings.trino_enabled:
            raise ApiError(ErrorCode.CONFLICT, "Trino query runtime is not enabled", status.HTTP_409_CONFLICT)
        payload = self.repository.get_run_payload(source_run_id)
        if payload is None or payload.get("engine") != "trino":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino source run not found", status.HTTP_404_NOT_FOUND)
        source_run = TrinoQueryRunResponse.model_validate(payload)
        is_submitter = (source_run.submitted_by_user_id and actor.id == source_run.submitted_by_user_id) or actor.name == source_run.submitted_by_name
        if not is_submitter and not actor.is_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "Only the source run submitter can materialize it", status.HTTP_403_FORBIDDEN)
        if request.source_run_id != source_run_id or request.source_dataset_id != source_run.base_dataset_id or request.query.strip() != source_run.query.strip() or set(request.reference_dataset_ids) != set(source_run.reference_dataset_ids):
            raise ApiError(ErrorCode.VALIDATION_ERROR, "Materialization request does not match the source query run", status.HTTP_422_UNPROCESSABLE_ENTITY)
        compiled_query = str(payload.get("compiledQuery") or "")
        dataset_name = request.dataset.name.strip() or f"{source_run.base_dataset_id}_analysis"
        dataset_slug = re.sub(r"[^a-z0-9_]+", "_", dataset_name.lower()).strip("_") or "sql_derived"
        dataset_id = f"ds_{dataset_slug}"
        target = QueryEngineTableRef(
            catalog=self.settings.trino_catalog,
            schema=self.settings.trino_schema,
            table=f"{dataset_id.removeprefix('ds_')}_mat",
            format="iceberg",
        )
        statement = build_trino_materialization_statement(source_run, target, compiled_query)
        page = self.client.submit(statement)
        materialization_id = f"materialize_{uuid4().hex[:12]}"
        response = TrinoMaterializationRunResponse(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            materialization_id=materialization_id,
            source_run_id=source_run_id,
            status=trino_status(page),
            trino_query_id=page.query_id or None,
        )
        persisted = response.model_dump(by_alias=True, mode="json")
        persisted.update({
            "engine": "trino-materialization",
            "query": statement,
            "trinoNextUri": page.next_uri,
            "request": request.model_dump(by_alias=True, mode="json"),
            "target": target.model_dump(by_alias=True, mode="json"),
            "submittedByName": actor.name,
            "submittedByUserId": actor.id,
        })
        self.repository.save_run_payload({"runId": materialization_id, "baseDatasetId": source_run.base_dataset_id, **persisted})
        if response.status == "succeeded":
            self._register_catalog_dataset(persisted, response)
            persisted["catalogRegisteredAt"] = "registered"
            self.repository.save_run_payload({"runId": materialization_id, "baseDatasetId": source_run.base_dataset_id, **persisted})
        safe_record_audit_event(self.repository.db, action="trino_materialization.submit", actor=actor, api_path=f"/api/catalog/trino-runs/{source_run_id}/materializations", http_method="POST", metadata={"materializationId": materialization_id, "trinoQueryId": response.trino_query_id}, target_id=materialization_id, target_type="dataset")
        return response

    def refresh(self, materialization_id: str, actor: ActorContext) -> TrinoMaterializationRunResponse:
        payload = self.repository.get_run_payload(materialization_id)
        if payload is None or payload.get("engine") != "trino-materialization":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino materialization run not found", status.HTTP_404_NOT_FOUND)
        is_submitter = (payload.get("submittedByUserId") and payload.get("submittedByUserId") == actor.id) or actor.name == payload.get("submittedByName")
        if not is_submitter and not actor.is_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "Only the materialization submitter can view it", status.HTTP_403_FORBIDDEN)
        response = TrinoMaterializationRunResponse.model_validate(payload)
        next_uri = str(payload.get("trinoNextUri") or "")
        if response.status in {"succeeded", "failed", "cancelled"} or not next_uri:
            return response
        page = self.client.fetch(next_uri)
        updated = response.model_copy(update={
            "status": trino_status(page),
            "trino_query_id": page.query_id or response.trino_query_id,
        })
        updated_payload = dict(payload)
        updated_payload.update(updated.model_dump(by_alias=True, mode="json"))
        updated_payload["trinoNextUri"] = page.next_uri
        self.repository.save_run_payload(updated_payload)
        if updated.status == "succeeded" and not payload.get("catalogRegisteredAt"):
            self._register_catalog_dataset(updated_payload, updated)
            updated_payload["catalogRegisteredAt"] = "registered"
            self.repository.save_run_payload(updated_payload)
        if updated.status in {"succeeded", "failed", "cancelled"} and updated.status != response.status:
            safe_record_audit_event(self.repository.db, action=f"trino_materialization.{updated.status}", actor=actor, api_path=f"/api/catalog/trino-materializations/{materialization_id}", http_method="GET", metadata={"trinoQueryId": updated.trino_query_id}, result="success" if updated.status == "succeeded" else "failed", target_id=materialization_id, target_type="dataset")
        return updated

    def _register_catalog_dataset(self, payload: dict[str, object], response: TrinoMaterializationRunResponse) -> CatalogDatasetResponse:
        request = CreateDerivedDatasetRequest.model_validate(payload["request"])
        target = QueryEngineTableRef.model_validate(payload["target"])
        source_payload = self.repository.get_run_payload(response.source_run_id) or {}
        source_run = TrinoQueryRunResponse.model_validate(source_payload)
        columns = source_run.result.columns if source_run.result else []
        dataset_payload = {
            "id": response.dataset_id,
            "name": response.dataset_name,
            "description": request.dataset.description,
            "layer": request.dataset.layer,
            "freshness": "latest",
            "lastUpdated": source_run.completed_at or source_run.submitted_at,
            "nextRefresh": "수동 갱신",
            "owner": payload.get("submittedByName") or "AskLake",
            "quality": "Trino Iceberg materialized",
            "rag": request.dataset.rag,
            "rows": f"{source_run.result.row_count or 0:,} rows",
            "sampleRows": [],
            "schema": [[column, "unknown"] for column in columns],
            "size": "Trino managed",
            "source": f"Trino CTAS · {response.source_run_id}",
            "sourceRunId": response.source_run_id,
            "status": "available",
            "storageFormat": "iceberg",
            "storageLocation": f"iceberg://{target.catalog}/{target.schema_}/{target.table}",
            "storageSizeBytes": 0,
            "queryEngineTable": target.model_dump(by_alias=True),
            "tags": request.dataset.tags,
            "upstream": [response.source_run_id, *request.reference_dataset_ids],
            "downstream": ["대시보드"],
            "materializationRuns": [{
                "createdAt": source_run.completed_at or source_run.submitted_at,
                "jobId": "trino-ctas",
                "rowCount": source_run.result.row_count or 0,
                "runId": response.materialization_id,
                "sourceKind": "sql",
                "sourceLabel": "Trino Iceberg CTAS",
                "status": "success",
                "storageLocation": f"iceberg://{target.catalog}/{target.schema_}/{target.table}",
                "storageSizeBytes": 0,
            }],
        }
        saved = self.catalog_repository.save_dataset_payload(dataset_payload)
        return CatalogDatasetResponse.model_validate(saved)
