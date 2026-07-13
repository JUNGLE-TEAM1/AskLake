import hashlib
import re
import unicodedata
from uuid import uuid4

from fastapi import status
from sqlalchemy.exc import IntegrityError

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.sql_repository import SqlRepository
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CreateDerivedDatasetRequest, QueryEngineTableRef
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoMaterializationRunResponse, TrinoQueryRunResponse
from app.services.trino_client import TrinoClient
from app.services.trino_materialization import build_trino_materialization_statement
from app.services.trino_query_run_service import TrinoQueryRunService, is_run_submitter, trino_status
from app.services.query_engine_registration_service import (
    QueryEngineRegistrationService,
    build_query_engine_table,
)


class TrinoMaterializationService:
    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
        runtime_settings: Settings | None = None,
        *,
        client: TrinoClient | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(
            self.settings,
            username=self.settings.trino_materializer_username,
            password=self.settings.trino_materializer_password,
        )
        self.registration = QueryEngineRegistrationService(
            self.catalog_repository,
            client=self.client,
            runtime_settings=self.settings,
        )
        self.query_access = TrinoQueryRunService(
            repository=self.repository,
            catalog_repository=self.catalog_repository,
            runtime_settings=self.settings,
        )

    def submit(self, source_run_id: str, request: CreateDerivedDatasetRequest, actor: ActorContext) -> TrinoMaterializationRunResponse:
        if not self.settings.trino_enabled:
            raise ApiError(ErrorCode.CONFLICT, "Trino query runtime is not enabled", status.HTTP_409_CONFLICT)
        payload = self.repository.get_run_payload(source_run_id)
        if payload is None or payload.get("engine") != "trino":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino source run not found", status.HTTP_404_NOT_FOUND)
        source_run = TrinoQueryRunResponse.model_validate(payload)
        if not is_run_submitter(source_run.submitted_by_user_id, source_run.submitted_by_name, actor) and not actor.is_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "Only the source run submitter can materialize it", status.HTTP_403_FORBIDDEN)
        self.query_access.require_query_access_for_run(
            source_run,
            actor,
            api_path=f"/api/catalog/trino-runs/{source_run_id}/materializations",
            http_method="POST",
        )
        if request.source_run_id != source_run_id or request.source_dataset_id != source_run.base_dataset_id or request.query.strip() != source_run.query.strip() or set(request.reference_dataset_ids) != set(source_run.reference_dataset_ids):
            raise ApiError(ErrorCode.VALIDATION_ERROR, "Materialization request does not match the source query run", status.HTTP_422_UNPROCESSABLE_ENTITY)
        compiled_query = str(payload.get("compiledQuery") or "")
        dataset_name = request.dataset.name.strip() or f"{source_run.base_dataset_id}_analysis"
        dataset_id = materialized_dataset_id(dataset_name)
        self._require_available_dataset_name(dataset_id, dataset_name)
        materialization_id = f"materialize_{uuid4().hex[:12]}"
        target = build_query_engine_table(dataset_name, materialization_id, self.settings)
        self._ensure_target_schema(target)
        statement = build_trino_materialization_statement(source_run, target, compiled_query)
        response = TrinoMaterializationRunResponse(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            materialization_id=materialization_id,
            source_run_id=source_run_id,
            status="queued",
            query_engine_status="pending",
        )
        dataset_payload = self._catalog_dataset_payload(
            source_run=source_run,
            request=request,
            response=response,
            owner=actor.name,
            target=target,
        )
        try:
            self.registration.save_pending(
                dataset_payload,
                actor=actor,
                run_id=materialization_id,
                target=target,
            )
        except IntegrityError as exc:
            self.repository.db.rollback()
            raise ApiError(
                ErrorCode.CONFLICT,
                "A Dataset with this name already exists",
                status.HTTP_409_CONFLICT,
                {"datasetId": dataset_id, "datasetName": dataset_name},
            ) from exc
        try:
            page = self.client.submit(statement)
        except Exception as exc:
            failed_response = response.model_copy(update={"status": "failed", "query_engine_status": "registration_failed"})
            self.registration.mark_failed(
                self._catalog_dataset_payload(
                    source_run=source_run,
                    request=request,
                    response=failed_response,
                    owner=actor.name,
                    target=target,
                ),
                actor=actor,
                run_id=materialization_id,
                target=target,
                error=exc,
            )
            raise
        response = TrinoMaterializationRunResponse(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            materialization_id=materialization_id,
            source_run_id=source_run_id,
            status=trino_status(page),
            query_engine_status="pending",
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
        persisted_payload = {"runId": materialization_id, "baseDatasetId": source_run.base_dataset_id, **persisted}
        self.repository.save_run_payload(persisted_payload)
        response = self._sync_catalog_registration(persisted_payload, response, actor, page.error)
        safe_record_audit_event(self.repository.db, action="trino_materialization.submit", actor=actor, api_path=f"/api/catalog/trino-runs/{source_run_id}/materializations", http_method="POST", metadata={"materializationId": materialization_id, "trinoQueryId": response.trino_query_id}, target_id=materialization_id, target_type="dataset")
        return response

    def refresh(self, materialization_id: str, actor: ActorContext) -> TrinoMaterializationRunResponse:
        payload = self.repository.get_run_payload(materialization_id)
        if payload is None or payload.get("engine") != "trino-materialization":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino materialization run not found", status.HTTP_404_NOT_FOUND)
        if not is_run_submitter(
            str(payload.get("submittedByUserId") or "") or None,
            str(payload.get("submittedByName") or "") or None,
            actor,
        ) and not actor.is_admin:
            raise ApiError(ErrorCode.FORBIDDEN, "Only the materialization submitter can view it", status.HTTP_403_FORBIDDEN)
        response = TrinoMaterializationRunResponse.model_validate(payload)
        source_payload = self.repository.get_run_payload(response.source_run_id)
        if source_payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Trino source run not found", status.HTTP_404_NOT_FOUND)
        self.query_access.require_query_access_for_run(
            TrinoQueryRunResponse.model_validate(source_payload),
            actor,
            api_path=f"/api/catalog/trino-materializations/{materialization_id}",
            http_method="GET",
        )
        return self._sync_catalog_registration(dict(payload), response, actor, None)

    def collect_claimed_run(self, materialization_id: str, worker_id: str, generation: int) -> TrinoMaterializationRunResponse:
        payload = self.repository.get_run_payload(materialization_id)
        if payload is None or payload.get("engine") != "trino-materialization":
            raise ApiError(ErrorCode.NOT_FOUND, "Trino materialization run not found", status.HTTP_404_NOT_FOUND)
        response = TrinoMaterializationRunResponse.model_validate(payload)
        pages_collected = 0

        while response.status not in {"succeeded", "failed", "cancelled"}:
            next_uri = str(payload.get("trinoNextUri") or "").strip()
            if not next_uri:
                break
            if not self.repository.renew_trino_collector_lease(
                materialization_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return TrinoMaterializationRunResponse.model_validate(self.repository.get_run_payload(materialization_id))
            page = self.client.fetch(next_uri)
            if not self.repository.renew_trino_collector_lease(
                materialization_id,
                worker_id,
                generation,
                self.settings.trino_collector_lease_seconds,
            ):
                return TrinoMaterializationRunResponse.model_validate(self.repository.get_run_payload(materialization_id))
            updated = response.model_copy(update={
                "status": trino_status(page),
                "trino_query_id": page.query_id or response.trino_query_id,
            })
            updated_payload = dict(payload)
            updated_payload.update(updated.model_dump(by_alias=True, mode="json"))
            updated_payload["trinoNextUri"] = page.next_uri
            if not self.repository.save_collector_run_payload(
                updated_payload,
                worker_id=worker_id,
                generation=generation,
            ):
                persisted = self.repository.get_run_payload(materialization_id)
                return TrinoMaterializationRunResponse.model_validate(persisted)
            if updated.status in {"succeeded", "failed", "cancelled"}:
                owner_actor = materialization_owner_actor(updated_payload, ActorContext(name="AskLake Collector", role="admin"))
                finalized = self._sync_catalog_registration(updated_payload, updated, owner_actor, page.error)
                safe_record_audit_event(
                    self.repository.db,
                    action=f"trino_materialization.{finalized.status}",
                    actor=ActorContext(name="AskLake Collector", role="admin"),
                    api_path="/internal/trino-result-collector",
                    http_method="POST",
                    metadata={"trinoQueryId": finalized.trino_query_id},
                    result="success" if finalized.status == "succeeded" else "failed",
                    target_id=materialization_id,
                    target_type="dataset",
                )
                return finalized
            response = updated
            payload = self.repository.get_run_payload(materialization_id) or updated_payload
            pages_collected += 1
            if pages_collected >= self.settings.trino_collector_pages_per_lease:
                self.repository.release_trino_collector_lease(materialization_id, worker_id, generation)
                return response

        self.repository.release_trino_collector_lease(materialization_id, worker_id, generation)
        return response

    def _sync_catalog_registration(
        self,
        payload: dict[str, object],
        response: TrinoMaterializationRunResponse,
        actor: ActorContext,
        trino_error: object | None,
    ) -> TrinoMaterializationRunResponse:
        if response.status not in {"succeeded", "failed", "cancelled"}:
            return response
        if response.status == "succeeded" and response.query_engine_status == "available":
            return response
        if response.status in {"failed", "cancelled"} and response.query_engine_status == "registration_failed":
            return response

        request = CreateDerivedDatasetRequest.model_validate(payload["request"])
        target = QueryEngineTableRef.model_validate(payload["target"])
        source_payload = self.repository.get_run_payload(response.source_run_id) or {}
        source_run = TrinoQueryRunResponse.model_validate(source_payload)
        owner_actor = materialization_owner_actor(payload, actor)
        terminal_response = response.model_copy(update={
            "query_engine_status": "available" if response.status == "succeeded" else "registration_failed",
        })
        dataset_payload = self._catalog_dataset_payload(
            source_run=source_run,
            request=request,
            response=terminal_response,
            owner=str(payload.get("submittedByName") or actor.name),
            target=target,
        )
        if response.status == "succeeded":
            dataset = self.registration.finalize(
                dataset_payload,
                actor=owner_actor,
                run_id=response.materialization_id,
                target=target,
            )
        else:
            error = trino_error if hasattr(trino_error, "code") else RuntimeError(f"TRINO_MATERIALIZATION_{response.status.upper()}")
            dataset = self.registration.mark_failed(
                dataset_payload,
                actor=owner_actor,
                run_id=response.materialization_id,
                target=target,
                error=error,
            )
        updated = response.model_copy(update={"query_engine_status": dataset.query_engine_status})
        updated_payload = dict(payload)
        updated_payload.update(updated.model_dump(by_alias=True, mode="json"))
        if dataset.query_engine_status == "available":
            updated_payload["catalogRegisteredAt"] = "registered"
        self.repository.save_run_payload(updated_payload)
        return updated

    def _catalog_dataset_payload(
        self,
        *,
        source_run: TrinoQueryRunResponse,
        request: CreateDerivedDatasetRequest,
        response: TrinoMaterializationRunResponse,
        owner: str,
        target: QueryEngineTableRef,
    ) -> dict[str, object]:
        columns = source_run.result.columns if source_run.result else []
        materialization_status = {
            "queued": "queued",
            "running": "running",
            "succeeded": "success",
            "failed": "failed",
            "cancelled": "canceled",
        }[response.status]
        dataset_payload = {
            "id": response.dataset_id,
            "name": response.dataset_name,
            "description": request.dataset.description,
            "layer": request.dataset.layer,
            "freshness": "latest",
            "lastUpdated": source_run.completed_at or source_run.submitted_at,
            "nextRefresh": "수동 갱신",
            "owner": owner or "AskLake",
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
            "queryEngineStatus": response.query_engine_status,
            "tags": request.dataset.tags,
            "upstream": [response.source_run_id, *request.reference_dataset_ids],
            "downstream": ["SQL 분석", "대시보드"],
            "materializationRuns": [{
                "createdAt": source_run.completed_at or source_run.submitted_at,
                "jobId": "trino-ctas",
                "rowCount": source_run.result.row_count or 0,
                "runId": response.materialization_id,
                "sourceKind": "sql",
                "sourceLabel": "Trino Iceberg CTAS",
                "status": materialization_status,
                "storageLocation": f"iceberg://{target.catalog}/{target.schema_}/{target.table}",
                "storageSizeBytes": 0,
            }],
        }
        return dataset_payload

    def _require_available_dataset_name(self, dataset_id: str, dataset_name: str) -> None:
        existing = self.catalog_repository.get_dataset_payload(dataset_id) or self.catalog_repository.get_dataset_payload_by_name(dataset_name)
        if existing is None:
            return
        materialization_runs = existing.get("materializationRuns")
        failed_run_id = str(materialization_runs[0].get("runId") or "") if isinstance(materialization_runs, list) and materialization_runs and isinstance(materialization_runs[0], dict) else ""
        if (
            existing.get("queryEngineStatus") == "registration_failed"
            and str(existing.get("source") or "").startswith("Trino CTAS")
            and (not failed_run_id or self.repository.get_run_payload(failed_run_id) is None)
        ):
            return
        raise ApiError(
            ErrorCode.CONFLICT,
            "A Dataset with this name already exists",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "datasetName": dataset_name},
        )

    def _ensure_target_schema(self, target: QueryEngineTableRef) -> None:
        statement = f"CREATE SCHEMA IF NOT EXISTS {quote_identifier(target.catalog)}.{quote_identifier(target.schema_)}"
        page = self.client.submit(statement)
        page_count = 0
        while page.next_uri and page.error is None:
            if page_count >= 20:
                raise ApiError(ErrorCode.BACKEND_TIMEOUT, "Trino schema bootstrap exceeded the page limit", status.HTTP_503_SERVICE_UNAVAILABLE)
            page = self.client.fetch(page.next_uri)
            page_count += 1
        if page.error is not None:
            raise ApiError(ErrorCode.CONFLICT, "Unable to prepare the Trino materialization schema", status.HTTP_409_CONFLICT, {"code": page.error.code})


def materialized_dataset_id(dataset_name: str) -> str:
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", dataset_name).strip()).casefold()
    slug = re.sub(r"[^a-z0-9_]+", "_", normalized).strip("_")
    slug = re.sub(r"_+", "_", slug)[:36].rstrip("_") or "dataset"
    suffix = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"ds_{slug}_{suffix}"


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def materialization_owner_actor(payload: dict[str, object], fallback: ActorContext) -> ActorContext:
    return ActorContext(
        name=str(payload.get("submittedByName") or fallback.name),
        role="viewer",
        id=str(payload.get("submittedByUserId") or "") or None,
    )
