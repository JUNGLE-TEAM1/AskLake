from uuid import uuid4
import re

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CreateDerivedDatasetRequest, QueryEngineTableRef
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoMaterializationRunResponse, TrinoQueryRunResponse
from app.services.trino_client import TrinoClient
from app.services.trino_materialization import build_trino_materialization_statement


class TrinoMaterializationService:
    def __init__(self, repository: SqlRepository, runtime_settings: Settings | None = None) -> None:
        self.repository = repository
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
        if source_run.submitted_by_user_id and actor.id != source_run.submitted_by_user_id and not actor.is_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "Only the source run submitter can materialize it", status.HTTP_403_FORBIDDEN)
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
            status="failed" if page.error else "running",
            trino_query_id=page.query_id or None,
        )
        persisted = response.model_dump(by_alias=True, mode="json")
        persisted.update({
            "engine": "trino-materialization",
            "query": statement,
            "trinoNextUri": page.next_uri,
            "request": request.model_dump(by_alias=True, mode="json"),
            "target": target.model_dump(by_alias=True, mode="json"),
        })
        self.repository.save_run_payload({"runId": materialization_id, "baseDatasetId": source_run.base_dataset_id, **persisted})
        return response
