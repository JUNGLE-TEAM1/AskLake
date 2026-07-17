"""Creation and reuse policy for full results linked to a preview run."""

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.sql_repository import SqlRepository
from app.schemas.common import ErrorCode
from app.schemas.trino import CreateTrinoFullResultRequest, SubmitTrinoQueryRunRequest, TrinoQueryRunResponse
from app.services.trino_query_access import TrinoQueryAccessService
from app.services.trino_query_estimate import create_confirmation_token
from app.services.trino_query_results import TrinoQueryResultService
from app.services.trino_query_run_store import TrinoQueryRunStore
from app.services.trino_query_submission import TrinoQuerySubmissionService


class TrinoFullResultService:
    def __init__(
        self,
        repository: SqlRepository,
        settings: Settings,
        access: TrinoQueryAccessService,
        results: TrinoQueryResultService,
        run_store: TrinoQueryRunStore,
        submission: TrinoQuerySubmissionService,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.access = access
        self.results = results
        self.run_store = run_store
        self.submission = submission

    def create(
        self,
        preview_run_id: str,
        request: CreateTrinoFullResultRequest,
        actor: ActorContext,
    ) -> TrinoQueryRunResponse:
        preview = self.run_store.load(preview_run_id)
        self.access.require_access_for_response(preview, actor, operation="view")
        self._require_ready_preview(preview)
        existing = self._reusable_run(preview_run_id, actor)
        if existing is not None:
            return existing
        context_datasets = self.access.resolve_context(SubmitTrinoQueryRunRequest(
            baseDatasetId=preview.base_dataset_id,
            query=preview.query,
            referenceDatasetIds=preview.reference_dataset_ids,
        ))
        confirmation_token = create_confirmation_token(
            actor=actor,
            context_datasets=context_datasets,
            query=preview.query,
            runtime_settings=self.settings,
        )
        return self.submission.submit(
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

    def _require_ready_preview(self, preview: TrinoQueryRunResponse) -> None:
        if preview.mode != "preview":
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Full results can only be created from a preview Query Run",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"runId": preview.run_id, "mode": preview.mode},
            )
        if preview.status == "succeeded" and preview.result and preview.result.storage_status == "available":
            return
        raise ApiError(
            ErrorCode.RESULT_PAGE_NOT_READY,
            "Wait for the preview result before creating the full result",
            status.HTTP_409_CONFLICT,
            {"runId": preview.run_id, "status": preview.status},
        )

    def _reusable_run(self, preview_run_id: str, actor: ActorContext) -> TrinoQueryRunResponse | None:
        payload = self.repository.get_latest_full_result_run_payload(preview_run_id)
        if payload is None:
            return None
        existing = TrinoQueryRunResponse.model_validate(payload)
        if existing.status in {"queued", "running"}:
            self.access.require_access_for_response(existing, actor, operation="view")
            return existing
        if existing.status != "succeeded" or not existing.result or existing.result.storage_status != "available":
            return None
        try:
            self.results.require_retention(existing)
        except ApiError as exc:
            if exc.code == ErrorCode.RESULT_EXPIRED:
                return None
            raise
        self.access.require_access_for_response(existing, actor, operation="view")
        return existing
