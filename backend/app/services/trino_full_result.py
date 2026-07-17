from typing import Protocol

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import CreateTrinoFullResultRequest, SubmitTrinoQueryRunRequest, TrinoQueryRunResponse
from app.services.trino_query_estimate import create_confirmation_token


class FullResultRunOwner(Protocol):
    repository: SqlRepository
    settings: Settings

    def get(self, run_id: str, actor: ActorContext | None = None) -> TrinoQueryRunResponse: ...

    def submit(
        self,
        request: SubmitTrinoQueryRunRequest,
        actor: ActorContext | None = None,
    ) -> TrinoQueryRunResponse: ...

    def _require_access_for_response(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        operation: str,
    ) -> None: ...

    def _require_result_retention(self, response: TrinoQueryRunResponse) -> None: ...

    def _resolve_context(self, request: SubmitTrinoQueryRunRequest) -> list[CatalogDatasetResponse]: ...


def create_linked_full_result_run(
    owner: FullResultRunOwner,
    preview_run_id: str,
    request: CreateTrinoFullResultRequest,
    actor: ActorContext,
) -> TrinoQueryRunResponse:
    preview = owner.get(preview_run_id, actor)
    if preview.mode != "preview":
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Full results can only be created from a preview Query Run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"runId": preview_run_id, "mode": preview.mode},
        )
    if preview.status != "succeeded" or preview.result is None or preview.result.storage_status != "available":
        raise ApiError(
            ErrorCode.RESULT_PAGE_NOT_READY,
            "Wait for the preview result before creating the full result",
            status.HTTP_409_CONFLICT,
            {"runId": preview_run_id, "status": preview.status},
        )

    existing_payload = owner.repository.get_latest_full_result_run_payload(preview_run_id)
    if existing_payload is not None:
        existing = TrinoQueryRunResponse.model_validate(existing_payload)
        if existing.status in {"queued", "running"}:
            owner._require_access_for_response(existing, actor, operation="view")
            return existing
        if existing.status == "succeeded" and existing.result and existing.result.storage_status == "available":
            try:
                owner._require_result_retention(existing)
            except ApiError as exc:
                if exc.code != ErrorCode.RESULT_EXPIRED:
                    raise
            else:
                owner._require_access_for_response(existing, actor, operation="view")
                return existing

    context_datasets = owner._resolve_context(SubmitTrinoQueryRunRequest(
        baseDatasetId=preview.base_dataset_id,
        query=preview.query,
        referenceDatasetIds=preview.reference_dataset_ids,
    ))
    confirmation_token = create_confirmation_token(
        actor=actor,
        context_datasets=context_datasets,
        query=preview.query,
        runtime_settings=owner.settings,
    )
    return owner.submit(
        SubmitTrinoQueryRunRequest(
            baseDatasetId=preview.base_dataset_id,
            clientRequestId=request.client_request_id,
            confirmationToken=confirmation_token,
            mode="run",
            query=preview.query,
            referenceDatasetIds=preview.reference_dataset_ids,
            resultPageSize=100,
            sourceRunId=preview.run_id,
        ),
        actor,
    )
