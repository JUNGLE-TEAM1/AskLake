from datetime import UTC, datetime
from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.models.dashboard_runtime import DashboardPage as DashboardPageModel
from app.models.dashboard_runtime import DashboardRevision as DashboardRevisionModel
from app.models.dashboard_runtime import DashboardWidget as DashboardWidgetModel
from app.repositories.dashboard_runtime_repository import DashboardRuntimeMetaRecord, DashboardRuntimeRepository
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    BarChartWidgetConfig,
    CreateDraftPageRequest,
    CreateDraftWidgetRequest,
    DashboardMeta,
    DashboardPageResponse,
    DashboardRevision,
    DashboardRuntimeMode,
    DashboardRuntimePage,
    DashboardRuntimeResponse,
    DashboardStatus,
    DashboardRuntimeWidget,
    DashboardRuntimeWidgetType,
    DashboardWidgetAggregation,
    DashboardWidgetConfigBase,
    DashboardWidgetFormat,
    DashboardWidgetLayout,
    DashboardWidgetMutationResponse,
    DeleteDraftPageResponse,
    DeleteDraftWidgetResponse,
    DonutChartWidgetConfig,
    LineChartWidgetConfig,
    MetricWidgetConfig,
    OkResponse,
    PublishDashboardResponse,
    SaveDraftLayoutsRequest,
    TableWidgetConfig,
    UpdateDraftPageRequest,
    UpdateDraftWidgetRequest,
)
from app.services.demo_catalog import dataset_rows_to_widget_data, get_demo_dataset


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

        revision = self._ensure_draft_revision(dashboard_id)
        self.repository.db.commit()

        return self._build_runtime_response(dashboard_meta, DashboardRuntimeMode.DRAFT, revision)

    def create_draft_page(self, dashboard_id: str, request: CreateDraftPageRequest) -> DashboardPageResponse:
        self._require_dashboard(dashboard_id)
        revision = self._ensure_draft_revision(dashboard_id)
        page = self.repository.create_page(
            revision.id,
            request.title,
            self.repository.get_next_page_order(revision.id),
        )
        self.repository.db.commit()
        return self._page_response(page)

    def update_draft_page(self, dashboard_id: str, page_id: str, request: UpdateDraftPageRequest) -> DashboardPageResponse:
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        page = self.repository.update_page_title(page, request.title)
        self.repository.db.commit()
        return self._page_response(page)

    def delete_draft_page(self, dashboard_id: str, page_id: str) -> DeleteDraftPageResponse:
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        self.repository.delete_page(page)
        self.repository.db.commit()
        return DeleteDraftPageResponse(ok=True)

    def create_draft_widget(
        self,
        dashboard_id: str,
        page_id: str,
        request: CreateDraftWidgetRequest,
    ) -> DashboardWidgetMutationResponse:
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        widget_type = self._widget_type_enum(request.type)
        widget = self.repository.create_widget(
            page.id,
            widget_type=widget_type.value,
            title=request.title,
            dataset_id=request.dataset_id,
            query_id=None,
            layout=self._layout_to_json(request.layout or self._default_layout()),
            config=self._config_to_json(widget_type, request.config),
            data=self._resolve_widget_data(request.data, request.dataset_id),
        )
        self.repository.db.commit()
        return DashboardWidgetMutationResponse(id=widget.id)

    def update_draft_widget(
        self,
        dashboard_id: str,
        widget_id: str,
        request: UpdateDraftWidgetRequest,
    ) -> DashboardWidgetMutationResponse:
        widget = self._get_draft_widget_or_raise(dashboard_id, widget_id)
        current_type = self._widget_type_enum(widget.type)
        next_type = self._widget_type_enum(request.type or current_type)
        type_changed = request.type is not None and next_type != current_type
        next_config = None
        if request.config is not None or type_changed:
            next_config = self._config_to_json(next_type, request.config)
        next_data = None
        update_data = False
        if "dataset_id" in request.model_fields_set:
            next_data = self._resolve_widget_data(None, request.dataset_id)
            update_data = True
        widget = self.repository.update_widget(
            widget,
            widget_type=next_type.value if type_changed else None,
            title=request.title,
            update_title="title" in request.model_fields_set,
            dataset_id=request.dataset_id,
            update_dataset_id="dataset_id" in request.model_fields_set,
            config=next_config,
            data=next_data,
            update_data=update_data,
        )
        self.repository.db.commit()
        return DashboardWidgetMutationResponse(id=widget.id)

    def delete_draft_widget(self, dashboard_id: str, widget_id: str) -> DeleteDraftWidgetResponse:
        widget = self._get_draft_widget_or_raise(dashboard_id, widget_id)
        self.repository.delete_widget(widget)
        self.repository.db.commit()
        return DeleteDraftWidgetResponse(ok=True, deleted_widget_id=widget_id)

    def save_draft_layouts(self, dashboard_id: str, request: SaveDraftLayoutsRequest) -> OkResponse:
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, request.page_id)
        for layout in request.layouts:
            widget = self._get_draft_widget_or_raise(dashboard_id, layout.widget_id)
            if widget.page_id != page.id:
                self._raise_widget_not_found(layout.widget_id)
            self.repository.update_widget_layout(widget, self._layout_to_json(layout))
        self.repository.db.commit()
        return OkResponse(ok=True)

    def publish_dashboard(self, dashboard_id: str) -> PublishDashboardResponse:
        self._require_dashboard(dashboard_id)
        draft_revision = self._get_draft_revision_or_raise(dashboard_id)
        published_revision = self.repository.copy_revision(draft_revision, DashboardRuntimeMode.PUBLISHED)
        published_revision_id = published_revision.id
        published_at = published_revision.published_at or datetime.now(UTC)
        self.repository.update_dashboard_published_metadata(dashboard_id, published_revision_id, published_at)
        self.repository.db.commit()
        return PublishDashboardResponse(
            dashboard_id=dashboard_id,
            published_revision_id=published_revision_id,
            published_at=self._datetime_to_iso(published_at) or published_at.isoformat(),
        )

    def _build_runtime_response(
        self,
        dashboard_meta: DashboardRuntimeMetaRecord,
        mode: DashboardRuntimeMode,
        revision: DashboardRevisionModel | None,
    ) -> DashboardRuntimeResponse:
        has_published_revision = (
            dashboard_meta.has_published_revision
            or (mode == DashboardRuntimeMode.PUBLISHED and revision is not None)
            or self.repository.get_published_revision(dashboard_meta.id) is not None
        )
        if revision is None:
            return DashboardRuntimeResponse(
                dashboard=self._dashboard_meta_to_schema(dashboard_meta, has_published_revision),
                mode=mode,
                revision=None,
                pages=[],
                widgets_by_page_id={},
                filters=[],
            )

        pages = self.repository.list_pages(revision.id)
        widgets_by_page_id = self.repository.list_widgets_by_page_ids([page.id for page in pages])

        return DashboardRuntimeResponse(
            dashboard=self._dashboard_meta_to_schema(dashboard_meta, has_published_revision),
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

    def _require_dashboard(self, dashboard_id: str) -> DashboardRuntimeMetaRecord:
        dashboard_meta = self.repository.get_dashboard_meta(dashboard_id)
        if dashboard_meta is None:
            self._raise_dashboard_not_found(dashboard_id)
        return dashboard_meta

    def _ensure_draft_revision(self, dashboard_id: str) -> DashboardRevisionModel:
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
        self.repository.db.flush()
        return revision

    def _get_draft_revision_or_raise(self, dashboard_id: str) -> DashboardRevisionModel:
        self._require_dashboard(dashboard_id)
        revision = self.repository.get_draft_revision(dashboard_id)
        if revision is None:
            raise ApiError(
                ErrorCode.NO_DRAFT_REVISION,
                "Draft revision is not prepared.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"dashboardId": dashboard_id},
            )
        return revision

    def _get_draft_page_or_raise(self, revision: DashboardRevisionModel, page_id: str) -> DashboardPageModel:
        page = self.repository.get_page(page_id)
        if page is None or page.revision_id != revision.id:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Draft page not found.",
                status.HTTP_404_NOT_FOUND,
                {"pageId": page_id},
            )
        return page

    def _get_draft_widget_or_raise(self, dashboard_id: str, widget_id: str) -> DashboardWidgetModel:
        revision = self._get_draft_revision_or_raise(dashboard_id)
        widget = self.repository.get_widget(widget_id)
        if widget is None:
            self._raise_widget_not_found(widget_id)

        page = self.repository.get_page(widget.page_id)
        if page is None or page.revision_id != revision.id:
            self._raise_widget_not_found(widget_id)
        return widget

    @staticmethod
    def _raise_widget_not_found(widget_id: str) -> None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            "Draft widget not found.",
            status.HTTP_404_NOT_FOUND,
            {"widgetId": widget_id},
        )

    @staticmethod
    def _dashboard_meta_to_schema(record: DashboardRuntimeMetaRecord, has_published_revision: bool) -> DashboardMeta:
        status_value = DashboardStatus.PUBLISHED if has_published_revision else record.status
        return DashboardMeta(
            id=record.id,
            title=record.title,
            status=status_value,
            has_published_revision=has_published_revision,
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
    def _page_response(page: DashboardPageModel) -> DashboardPageResponse:
        return DashboardPageResponse(
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
    def _layout_to_json(layout: DashboardWidgetLayout) -> dict[str, int]:
        return {
            key: value
            for key, value in {
                "x": layout.x,
                "y": layout.y,
                "w": layout.w,
                "h": layout.h,
                "minW": layout.min_w,
                "minH": layout.min_h,
            }.items()
            if value is not None
        }

    @staticmethod
    def _config_to_json(
        widget_type: DashboardRuntimeWidgetType,
        config: DashboardWidgetConfigBase | None,
    ) -> dict[str, object]:
        resolved_config = config or DashboardRuntimeService._default_config(widget_type)
        return resolved_config.model_dump(by_alias=True, exclude_none=True, mode="json")

    @staticmethod
    def _default_layout() -> DashboardWidgetLayout:
        return DashboardWidgetLayout(x=0, y=0, w=4, h=3, min_w=2, min_h=2)

    @staticmethod
    def _widget_type_enum(value: DashboardRuntimeWidgetType | str) -> DashboardRuntimeWidgetType:
        return value if isinstance(value, DashboardRuntimeWidgetType) else DashboardRuntimeWidgetType(value)

    @staticmethod
    def _resolve_widget_data(
        explicit_data: list[dict[str, Any]] | None,
        dataset_id: str | None,
    ) -> list[dict[str, Any]]:
        if explicit_data is not None:
            return explicit_data
        return dataset_rows_to_widget_data(get_demo_dataset(dataset_id))

    @staticmethod
    def _default_config(widget_type: DashboardRuntimeWidgetType) -> DashboardWidgetConfigBase:
        if widget_type == DashboardRuntimeWidgetType.METRIC:
            return MetricWidgetConfig(
                aggregation=DashboardWidgetAggregation.COUNT,
                color="#3b82f6",
                format=DashboardWidgetFormat.NUMBER,
                value_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.TABLE:
            return TableWidgetConfig(columns=[])
        if widget_type == DashboardRuntimeWidgetType.LINE_CHART:
            return LineChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color="#6366f1",
                x_key="category",
                y_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.DONUT_CHART:
            return DonutChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color="#8b5cf6",
                label_key="category",
                value_key="value",
            )
        return BarChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color="#6366f1",
            x_key="category",
            y_key="value",
        )

    @staticmethod
    def _datetime_to_iso(value: datetime | None) -> str | None:
        if value is None:
            return None
        return value.isoformat()
