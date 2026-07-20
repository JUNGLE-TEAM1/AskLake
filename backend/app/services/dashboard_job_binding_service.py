from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlJobModel
from app.models.dashboard_job_binding import DashboardBindingDeliveryModel, DashboardJobBindingModel
from app.models.dashboard_runtime import DashboardPage, DashboardRevision, DashboardWidget
from app.models.etl import ETLJobModel
from app.repositories.dashboard_job_binding_repository import DashboardJobBindingRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    DashboardBindingDeliveryStatus,
    DashboardBindingMode,
    DashboardJobBinding,
    DashboardJobBindingCreateRequest,
    DashboardJobBindingDelivery,
    DashboardJobBindingList,
    DashboardJobKind,
)
from app.services.dashboard_runtime_service import DashboardRuntimeService


class DashboardJobBindingService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repository = DashboardJobBindingRepository(db)
        self.dashboard_service = DashboardRuntimeService(
            DashboardRuntimeRepository(db),
            CatalogRepository(db),
        )

    def create(self, request: DashboardJobBindingCreateRequest, actor: ActorContext) -> DashboardJobBinding:
        self.dashboard_service._require_dashboard_permission(request.dashboard_id, actor, "manage")
        self._require_empty_dashboard(request.dashboard_id)
        self._require_job_output(request, actor)
        existing = self.repository.get_by_dashboard(request.dashboard_id)
        job_kind = str(request.job_kind)
        if existing is not None and existing.mode == DashboardBindingMode.MANAGED.value:
            if (existing.job_id, existing.job_kind, existing.output_dataset_id) == (request.job_id, job_kind, request.output_dataset_id):
                return self._to_schema(existing)
            raise ApiError(ErrorCode.CONFLICT, "Dashboard already has a managed Job binding.", status.HTTP_409_CONFLICT)
        if existing is None:
            existing = DashboardJobBindingModel(
                id=f"dashbind-{uuid4().hex}", dashboard_id=request.dashboard_id,
                job_id=request.job_id, job_kind=job_kind,
                output_dataset_id=request.output_dataset_id, mode=DashboardBindingMode.MANAGED.value,
                enabled=True, created_by=actor.name,
            )
        else:
            existing.job_id = request.job_id
            existing.job_kind = job_kind
            existing.output_dataset_id = request.output_dataset_id
            existing.mode = DashboardBindingMode.MANAGED.value
            existing.enabled = True
            existing.detached_at = None
        return self._to_schema(self.repository.save(existing))

    def get(self, binding_id: str, actor: ActorContext) -> DashboardJobBinding:
        binding = self._require_binding(binding_id)
        self.dashboard_service._require_dashboard_permission(binding.dashboard_id, actor, "view")
        return self._to_schema(binding)

    def list(self, actor: ActorContext, *, job_id: str | None, job_kind: DashboardJobKind | None, dashboard_id: str | None) -> DashboardJobBindingList:
        if not any((job_id, dashboard_id)):
            raise ApiError(ErrorCode.VALIDATION_ERROR, "Specify jobId or dashboardId.", status.HTTP_422_UNPROCESSABLE_ENTITY)
        if job_id is not None:
            if job_kind is None:
                raise ApiError(ErrorCode.VALIDATION_ERROR, "jobKind is required with jobId.", status.HTTP_422_UNPROCESSABLE_ENTITY)
            self._require_job_view(job_id, job_kind, actor)
        items = self.repository.list(job_id=job_id, job_kind=str(job_kind) if job_kind else None, dashboard_id=dashboard_id)
        visible = []
        for binding in items:
            try:
                self.dashboard_service._require_dashboard_permission(binding.dashboard_id, actor, "view")
            except ApiError as exc:
                if exc.status_code != status.HTTP_403_FORBIDDEN:
                    raise
                continue
            visible.append(self._to_schema(binding))
        return DashboardJobBindingList(items=visible)

    def detach(self, binding_id: str, actor: ActorContext) -> DashboardJobBinding:
        binding = self._require_binding(binding_id)
        self.dashboard_service._require_dashboard_permission(binding.dashboard_id, actor, "manage")
        binding.mode = DashboardBindingMode.DETACHED.value
        binding.enabled = False
        binding.detached_at = datetime.now(UTC)
        return self._to_schema(self.repository.save(binding))

    def retry(self, binding_id: str, dataset_revision: int, actor: ActorContext) -> DashboardJobBinding:
        binding = self._require_binding(binding_id)
        self.dashboard_service._require_dashboard_permission(binding.dashboard_id, actor, "manage")
        delivery = self.repository.get_delivery(binding.id, dataset_revision)
        if delivery is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Binding delivery not found.", status.HTTP_404_NOT_FOUND)
        if binding.mode != DashboardBindingMode.MANAGED.value:
            raise ApiError(ErrorCode.CONFLICT, "Detached bindings cannot be retried.", status.HTTP_409_CONFLICT)
        delivery.status = DashboardBindingDeliveryStatus.PENDING.value
        delivery.error_code = None
        delivery.error_message = None
        delivery.attempt_count += 1
        self.db.commit()
        self.db.refresh(delivery)
        return self._to_schema(binding)

    def _require_binding(self, binding_id: str) -> DashboardJobBindingModel:
        binding = self.repository.get(binding_id)
        if binding is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dashboard Job binding not found.", status.HTTP_404_NOT_FOUND)
        return binding

    def _require_job_output(self, request: DashboardJobBindingCreateRequest, actor: ActorContext) -> None:
        if request.job_kind == DashboardJobKind.ETL:
            job = self.db.get(ETLJobModel, request.job_id)
            expected_dataset_id = job.dataset_id if job else None
        else:
            job = self.db.get(ContinuousSqlJobModel, request.job_id)
            expected_dataset_id = job.output_dataset_id if job else None
        if job is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Job not found.", status.HTTP_404_NOT_FOUND)
        require_permission(actor, "manage", owner=job.owner, resource_label="job")
        if expected_dataset_id != request.output_dataset_id:
            raise ApiError(ErrorCode.CONFLICT, "outputDatasetId must be the Job output Dataset.", status.HTTP_409_CONFLICT)

    def _require_job_view(self, job_id: str, job_kind: DashboardJobKind, actor: ActorContext) -> None:
        job = self.db.get(ETLJobModel if job_kind == DashboardJobKind.ETL else ContinuousSqlJobModel, job_id)
        if job is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Job not found.", status.HTTP_404_NOT_FOUND)
        require_permission(actor, "view", owner=job.owner, resource_label="job")

    def _require_empty_dashboard(self, dashboard_id: str) -> None:
        widget_count = self.db.scalar(
            select(func.count(DashboardWidget.id))
            .join(DashboardPage, DashboardWidget.page_id == DashboardPage.id)
            .join(DashboardRevision, DashboardPage.revision_id == DashboardRevision.id)
            .where(DashboardRevision.dashboard_id == dashboard_id)
        ) or 0
        if widget_count:
            raise ApiError(ErrorCode.CONFLICT, "V1 binding is available only for an empty Dashboard.", status.HTTP_409_CONFLICT)

    def _to_schema(self, binding: DashboardJobBindingModel) -> DashboardJobBinding:
        delivery = self.db.scalars(
            select(DashboardBindingDeliveryModel).where(DashboardBindingDeliveryModel.binding_id == binding.id)
            .order_by(DashboardBindingDeliveryModel.dataset_revision.desc()).limit(1)
        ).first()
        latest = None if delivery is None else DashboardJobBindingDelivery(
            dataset_revision=delivery.dataset_revision, mutation_type=delivery.mutation_type,
            status=DashboardBindingDeliveryStatus(delivery.status), applied_revision=delivery.applied_revision,
            calculated_at=delivery.calculated_at.isoformat() if delivery.calculated_at else None,
            attempt_count=delivery.attempt_count, error_code=delivery.error_code, error_message=delivery.error_message,
        )
        return DashboardJobBinding(
            id=binding.id, dashboard_id=binding.dashboard_id, job_id=binding.job_id,
            job_kind=DashboardJobKind(binding.job_kind), output_dataset_id=binding.output_dataset_id,
            mode=DashboardBindingMode(binding.mode), enabled=binding.enabled, created_by=binding.created_by,
            detached_at=binding.detached_at.isoformat() if binding.detached_at else None,
            created_at=binding.created_at.isoformat(), updated_at=binding.updated_at.isoformat(), latest_delivery=latest,
        )
