from datetime import datetime

from fastapi import status

from app.core.errors import ApiError
from app.models.dashboard_runtime import DashboardPage as DashboardPageModel
from app.models.dashboard_runtime import DashboardRevision as DashboardRevisionModel
from app.models.dashboard_runtime import DashboardWidget as DashboardWidgetModel
from app.repositories.dashboard_runtime_repository import DashboardRuntimeMetaRecord, DashboardRuntimeRepository
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    DashboardMeta,
    DashboardRevision,
    DashboardRuntimeMode,
    DashboardRuntimePage,
    DashboardRuntimeResponse,
    DashboardRuntimeWidget,
    DashboardRuntimeWidgetType,
    DashboardWidgetLayout,
)


class DashboardRuntimeService:
    def __init__(self, repository: DashboardRuntimeRepository) -> None:
        self.repository = repository

    def get_published_runtime(self, dashboard_id: str) -> DashboardRuntimeResponse:
        dashboard_meta = self.repository.get_dashboard_meta(dashboard_id)
        if dashboard_meta is None:
            self._raise_dashboard_not_found(dashboard_id)

        revision = self.repository.get_published_revision(dashboard_id)
        return self._build_runtime_response(dashboard_meta, DashboardRuntimeMode.PUBLISHED, revision)

    def ensure_draft_runtime(self, dashboard_id: str) -> DashboardRuntimeResponse:
        dashboard_meta = self.repository.get_dashboard_meta(dashboard_id)
        if dashboard_meta is None:
            self._raise_dashboard_not_found(dashboard_id)

        revision = self.repository.get_draft_revision(dashboard_id)
        if revision is None:
            published_revision = self.repository.get_published_revision(dashboard_id)
            revision = (
                self.repository.copy_revision(published_revision, DashboardRuntimeMode.DRAFT)
                if published_revision is not None
                else self.repository.create_revision(dashboard_id, DashboardRuntimeMode.DRAFT)
            )
            if not self.repository.list_pages(revision.id):
                self.repository.create_page(revision.id, "Untitled page", 0)
            self.repository.db.commit()

        return self._build_runtime_response(dashboard_meta, DashboardRuntimeMode.DRAFT, revision)

    def _build_runtime_response(
        self,
        dashboard_meta: DashboardRuntimeMetaRecord,
        mode: DashboardRuntimeMode,
        revision: DashboardRevisionModel | None,
    ) -> DashboardRuntimeResponse:
        if revision is None:
            return DashboardRuntimeResponse(
                dashboard=self._dashboard_meta_to_schema(dashboard_meta),
                mode=mode,
                revision=None,
                pages=[],
                widgets_by_page_id={},
                filters=[],
            )

        pages = self.repository.list_pages(revision.id)
        widgets_by_page_id = self.repository.list_widgets_by_page_ids([page.id for page in pages])

        return DashboardRuntimeResponse(
            dashboard=self._dashboard_meta_to_schema(dashboard_meta),
            mode=mode,
            revision=self._revision_to_schema(revision),
            pages=[self._page_to_schema(page) for page in pages],
            widgets_by_page_id={
                page_id: [self._widget_to_schema(widget) for widget in widgets]
                for page_id, widgets in widgets_by_page_id.items()
            },
            filters=[],
        )

    @staticmethod
    def _raise_dashboard_not_found(dashboard_id: str) -> None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            "Dashboard not found.",
            status.HTTP_404_NOT_FOUND,
            {"dashboardId": dashboard_id},
        )

    @staticmethod
    def _dashboard_meta_to_schema(record: DashboardRuntimeMetaRecord) -> DashboardMeta:
        return DashboardMeta(
            id=record.id,
            title=record.title,
            status=record.status,
            has_published_revision=record.has_published_revision,
            updated_at=DashboardRuntimeService._datetime_to_iso(record.updated_at),
        )

    @staticmethod
    def _revision_to_schema(revision: DashboardRevisionModel) -> DashboardRevision:
        return DashboardRevision(
            id=revision.id,
            kind=DashboardRuntimeMode(revision.kind),
            version=revision.version,
            published_at=DashboardRuntimeService._datetime_to_iso(revision.published_at),
        )

    @staticmethod
    def _page_to_schema(page: DashboardPageModel) -> DashboardRuntimePage:
        return DashboardRuntimePage(
            id=page.id,
            title=page.title,
            order_index=page.order_index,
        )

    @staticmethod
    def _widget_to_schema(widget: DashboardWidgetModel) -> DashboardRuntimeWidget:
        return DashboardRuntimeWidget(
            id=widget.id,
            page_id=widget.page_id,
            type=DashboardRuntimeWidgetType(widget.type),
            title=widget.title,
            layout=DashboardWidgetLayout(**widget.layout),
            config=widget.config,
            data=widget.data,
            dataset_id=widget.dataset_id,
            query_id=widget.query_id,
        )

    @staticmethod
    def _datetime_to_iso(value: datetime | None) -> str | None:
        if value is None:
            return None
        return value.isoformat()
