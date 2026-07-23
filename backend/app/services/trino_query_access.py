"""Dataset and Query Run authorization for the Trino query feature."""

from collections.abc import Iterable

from fastapi import status

from app.core.auth_context import ActorContext, can, require_permission
from app.core.errors import ApiError
from app.domain.audit import AuditTargetType
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import SubmitTrinoQueryRunRequest, TrinoQueryRunResponse
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants
from app.services.trino_query_run_state import is_run_submitter, query_audit_metadata, unique_values


class TrinoQueryAccessService:
    def __init__(self, repository: SqlRepository, catalog_repository: CatalogRepository) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository

    def resolve_context(self, request: SubmitTrinoQueryRunRequest) -> list[CatalogDatasetResponse]:
        base_dataset = self.get_dataset(request.base_dataset_id, label="Base dataset")
        reference_ids = unique_values(request.reference_dataset_ids)
        return [
            base_dataset,
            *(self.get_dataset(dataset_id, label="Reference dataset") for dataset_id in reference_ids),
        ]

    def get_dataset(self, dataset_id: str, *, label: str) -> CatalogDatasetResponse:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"{label} not found",
                status.HTTP_404_NOT_FOUND,
                {"datasetId": dataset_id},
            )
        return dataset_with_persisted_permission_grants(
            self.catalog_repository.db,
            CatalogDatasetResponse.model_validate(payload),
        )

    def require_query_access(
        self,
        datasets: Iterable[CatalogDatasetResponse],
        actor: ActorContext,
        query: str,
        *,
        api_path: str = "/api/query/runs",
        http_method: str = "POST",
    ) -> None:
        for dataset in datasets:
            require_governed_access(
                self.repository.db,
                actor,
                action="query",
                api_path=api_path,
                http_method=http_method,
                metadata={"owner": dataset.owner, **query_audit_metadata(query)},
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            try:
                require_permission(
                    actor,
                    "query",
                    owner=dataset.owner,
                    grants=dataset.permission_grants,
                    resource_label="dataset",
                )
            except ApiError as exc:
                self._record_forbidden_dataset_query(dataset, actor, query, api_path, http_method, exc)
                raise

    def require_query_access_for_run(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        api_path: str,
        http_method: str,
    ) -> list[CatalogDatasetResponse]:
        context_datasets = [
            self.get_dataset(response.base_dataset_id, label="Base dataset"),
            *(self.get_dataset(dataset_id, label="Reference dataset") for dataset_id in response.reference_dataset_ids),
        ]
        self.require_query_access(
            context_datasets,
            actor,
            response.query,
            api_path=api_path,
            http_method=http_method,
        )
        return context_datasets

    def require_access_for_response(
        self,
        response: TrinoQueryRunResponse,
        actor: ActorContext,
        *,
        operation: str,
    ) -> None:
        context_datasets = self.require_query_access_for_run(
            response,
            actor,
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="POST" if operation == "cancel" else "GET",
        )
        is_submitter = is_run_submitter(response.submitted_by_user_id, response.submitted_by_name, actor)
        can_manage = can(
            actor,
            "manage",
            owner=context_datasets[0].owner,
            grants=[grant.model_dump(by_alias=True) for grant in context_datasets[0].permission_grants],
        )
        if actor.is_admin or is_submitter or (operation == "cancel" and can_manage):
            return
        safe_record_audit_event(
            self.repository.db,
            action=f"query_run.{operation}.forbidden",
            actor=actor,
            api_path=f"/api/query/runs/{response.run_id}",
            http_method="POST" if operation == "cancel" else "GET",
            metadata={"trinoQueryId": response.trino_query_id},
            result="forbidden",
            status_code=status.HTTP_403_FORBIDDEN,
            target_id=response.run_id,
            target_type=AuditTargetType.QUERY_RUN,
        )
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only the submitting user can view this query run",
            status.HTTP_403_FORBIDDEN,
        )

    def _record_forbidden_dataset_query(
        self,
        dataset: CatalogDatasetResponse,
        actor: ActorContext,
        query: str,
        api_path: str,
        http_method: str,
        error: ApiError,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action="dataset.query.forbidden",
            actor=actor,
            api_path=api_path,
            http_method=http_method,
            metadata={"owner": dataset.owner, **query_audit_metadata(query)},
            result="forbidden",
            status_code=error.status_code,
            target_id=dataset.id,
            target_name=dataset.name,
            target_type=AuditTargetType.DATASET,
        )
