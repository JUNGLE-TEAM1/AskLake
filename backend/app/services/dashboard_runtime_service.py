import json
import hashlib
import logging
import time
from datetime import UTC, datetime
from typing import Any

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext, require_permission
from app.core.compatibility import CompatibilityPath, record_compatibility_path
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles
from app.models.dashboard_runtime import DashboardPage as DashboardPageModel
from app.models.dashboard_runtime import DashboardRevision as DashboardRevisionModel
from app.models.dashboard_runtime import DashboardWidget as DashboardWidgetModel
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.dashboard_card_repository import get_dashboard_card
from app.repositories.dashboard_runtime_repository import DashboardRuntimeMetaRecord, DashboardRuntimeRepository
from app.repositories.dashboard_live_repository import (
    BACKFILL_COMMIT_KIND,
    LEGACY_COMMIT_KIND,
    DashboardLiveRepository,
)
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.common import ErrorCode
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    BarChartWidgetConfig,
    CreateDraftPageRequest,
    CreateDraftWidgetRequest,
    DashboardCard,
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
    DashboardWidgetColorConfig,
    DashboardWidgetConfigBase,
    DashboardWidgetFormat,
    DashboardWidgetLayout,
    DashboardWidgetLineCurve,
    DashboardWidgetOrientation,
    DashboardWidgetMutationResponse,
    DeleteDraftPageResponse,
    DeleteDraftWidgetResponse,
    DonutChartWidgetConfig,
    HeatmapChartWidgetConfig,
    LineChartWidgetConfig,
    MetricWidgetConfig,
    OkResponse,
    PieChartWidgetConfig,
    PublishDashboardResponse,
    RadialBarChartWidgetConfig,
    SaveDraftLayoutsRequest,
    TableWidgetConfig,
    TreemapChartWidgetConfig,
    UpdateDraftPageRequest,
    UpdateDraftWidgetRequest,
)
from app.services.governance_enforcement import require_governed_access
from app.services.dashboard_dataset_access import require_dashboard_dataset_query_access
from app.services.resource_permission_service import (
    dashboard_with_persisted_permission_grants,
    dataset_with_persisted_permission_grants,
    permissions_for_actor_with_governance,
)
from app.services.dashboard_physical_data import (
    DashboardDatasetQuerySession,
    DashboardRemoteScanBudget,
    dashboard_result_from_aggregate_state,
    dashboard_source_config,
    dashboard_widget_supports_incremental_merge,
    merge_dashboard_aggregate_states,
)
from app.services.dashboard_realtime_bridge import (
    DASHBOARD_LEGACY_COLOR_MAP,
    append_dashboard_published_event,
    dashboard_datetime_to_iso,
    dashboard_widget_type_enum,
    default_dashboard_widget_layout,
    published_snapshot_event_cursor,
)


MAX_EXPLICIT_WIDGET_ROWS = 500
DASHBOARD_DATA_FORBIDDEN = "DASHBOARD_DATA_FORBIDDEN"
DASHBOARD_DATA_UNAVAILABLE = "DASHBOARD_DATA_UNAVAILABLE"
logger = logging.getLogger(__name__)


class DashboardRuntimeService:
    def __init__(
        self,
        repository: DashboardRuntimeRepository,
        catalog_repository: CatalogRepository,
        live_repository: DashboardLiveRepository | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.live_repository = live_repository
        self._continuous_job_cache: dict[str, object | None] = {}

    def get_published_runtime(
        self,
        dashboard_id: str,
        actor: ActorContext | None = None,
        *,
        include_data: bool = True,
    ) -> DashboardRuntimeResponse:
        actor_context = actor or ActorContext()
        dashboard_meta = self.repository.get_dashboard_meta(dashboard_id)
        if dashboard_meta is None:
            self._raise_dashboard_not_found(dashboard_id)
        dashboard_card = self._require_dashboard_permission(dashboard_id, actor_context, "view")

        revision = self.repository.get_published_revision(dashboard_id)
        return self._build_runtime_response(
            dashboard_meta,
            DashboardRuntimeMode.PUBLISHED,
            revision,
            actor_context,
            dashboard_card,
            include_data=include_data,
        )

    def query_published_widgets(
        self,
        dashboard_id: str,
        widget_ids: list[str],
        actor: ActorContext | None = None,
    ) -> list[DashboardRuntimeWidget]:
        return self.query_widgets(
            dashboard_id,
            widget_ids,
            DashboardRuntimeMode.PUBLISHED,
            actor,
        )

    def query_widgets(
        self,
        dashboard_id: str,
        widget_ids: list[str],
        mode: DashboardRuntimeMode,
        actor: ActorContext | None = None,
    ) -> list[DashboardRuntimeWidget]:
        actor_context = actor or ActorContext()
        dashboard_meta = self._require_dashboard(dashboard_id)
        action = "view" if mode == DashboardRuntimeMode.PUBLISHED else "manage"
        self._require_dashboard_permission(dashboard_id, actor_context, action)
        revision = (
            self.repository.get_published_revision(dashboard_id)
            if mode == DashboardRuntimeMode.PUBLISHED
            else self.repository.get_draft_revision(dashboard_id)
        )
        if revision is None:
            return []
        pages = self.repository.list_pages(revision.id)
        widgets_by_page = self.repository.list_widgets_by_page_ids([page.id for page in pages])
        available = {
            widget.id: widget
            for widgets in widgets_by_page.values()
            for widget in widgets
        }
        requested_ids = list(dict.fromkeys(widget_ids))
        missing = [widget_id for widget_id in requested_ids if widget_id not in available]
        if missing:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"{mode.value.capitalize()} dashboard widget not found.",
                status.HTTP_404_NOT_FOUND,
                {"dashboardId": dashboard_meta.id, "widgetIds": missing},
            )

        sessions: dict[str, DashboardDatasetQuerySession] = {}
        remote_budget = DashboardRemoteScanBudget.from_environment()
        try:
            return [
                self._widget_to_schema(
                    available[widget_id],
                    sessions,
                    {},
                    {},
                    {},
                    actor=actor_context,
                    remote_budget=remote_budget,
                    api_path=f"/api/dashboards/{dashboard_id}/widgets/query",
                    http_method="POST",
                    use_live_results=mode == DashboardRuntimeMode.PUBLISHED,
                )
                for widget_id in requested_ids
            ]
        finally:
            for session in sessions.values():
                session.close()

    def require_assistant_access(self, dashboard_id: str, actor: ActorContext) -> None:
        self._require_dashboard_permission(dashboard_id, actor, "view")

    def ensure_draft_runtime(
        self,
        dashboard_id: str,
        actor: ActorContext | None = None,
        *,
        include_data: bool = True,
    ) -> DashboardRuntimeResponse:
        actor_context = actor or ActorContext()
        dashboard_meta = self.repository.get_dashboard_meta(dashboard_id)
        if dashboard_meta is None:
            self._raise_dashboard_not_found(dashboard_id)
        dashboard_card = self._require_dashboard_permission(dashboard_id, actor_context, "manage")

        revision = self._ensure_draft_revision(dashboard_id)
        self.repository.db.commit()

        return self._build_runtime_response(
            dashboard_meta,
            DashboardRuntimeMode.DRAFT,
            revision,
            actor_context,
            dashboard_card,
            include_data=include_data,
        )

    def create_draft_page(self, dashboard_id: str, request: CreateDraftPageRequest, actor: ActorContext | None = None) -> DashboardPageResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        revision = self._ensure_draft_revision(dashboard_id)
        page = self.repository.create_page(
            revision.id,
            request.title,
            self.repository.get_next_page_order(revision.id),
        )
        self.repository.db.commit()
        return self._page_response(page)

    def update_draft_page(self, dashboard_id: str, page_id: str, request: UpdateDraftPageRequest, actor: ActorContext | None = None) -> DashboardPageResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        page = self.repository.update_page_title(page, request.title)
        self.repository.db.commit()
        return self._page_response(page)

    def delete_draft_page(self, dashboard_id: str, page_id: str, actor: ActorContext | None = None) -> DeleteDraftPageResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        self.repository.delete_page(page)
        remaining_pages = self.repository.list_pages(revision.id)
        replacement_page = None
        if not remaining_pages:
            replacement_page = self.repository.create_page(revision.id, "Untitled page", 0)
        self.repository.db.commit()
        return DeleteDraftPageResponse(
            ok=True,
            replacement_page=self._page_response(replacement_page) if replacement_page else None,
        )

    def create_draft_widget(
        self,
        dashboard_id: str,
        page_id: str,
        request: CreateDraftWidgetRequest,
        actor: ActorContext | None = None,
    ) -> DashboardWidgetMutationResponse:
        actor_context = actor or ActorContext()
        self._require_dashboard_permission(dashboard_id, actor_context, "manage")
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, page_id)
        widget_type = dashboard_widget_type_enum(request.type)
        widget = self.repository.create_widget(
            page.id,
            widget_type=widget_type.value,
            title=request.title,
            dataset_id=request.dataset_id,
            query_id=None,
            layout=self._layout_to_json(request.layout or default_dashboard_widget_layout()),
            config=self._config_to_json(widget_type, request.config),
            data=self._resolve_widget_data(request.data, request.dataset_id),
        )
        self.repository.db.commit()
        return self._build_widget_mutation_response(
            dashboard_id,
            widget,
            actor_context,
            api_path=f"/api/dashboards/{dashboard_id}/draft/pages/{page_id}/widgets",
            http_method="POST",
        )

    def update_draft_widget(
        self,
        dashboard_id: str,
        widget_id: str,
        request: UpdateDraftWidgetRequest,
        actor: ActorContext | None = None,
    ) -> DashboardWidgetMutationResponse:
        actor_context = actor or ActorContext()
        self._require_dashboard_permission(dashboard_id, actor_context, "manage")
        widget = self._get_draft_widget_or_raise(dashboard_id, widget_id)
        current_type = dashboard_widget_type_enum(widget.type)
        next_type = dashboard_widget_type_enum(request.type or current_type)
        type_changed = request.type is not None and next_type != current_type
        next_config = None
        if request.config is not None or type_changed:
            next_config = self._config_to_json(next_type, request.config)
        next_data = None
        update_data = False
        if "data" in request.model_fields_set:
            next_data = self._resolve_widget_data(request.data, request.dataset_id)
            update_data = True
        elif "dataset_id" in request.model_fields_set:
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
        return self._build_widget_mutation_response(
            dashboard_id,
            widget,
            actor_context,
            api_path=f"/api/dashboards/{dashboard_id}/draft/widgets/{widget_id}",
            http_method="PATCH",
        )

    def delete_draft_widget(self, dashboard_id: str, widget_id: str, actor: ActorContext | None = None) -> DeleteDraftWidgetResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        widget = self._get_draft_widget_or_raise(dashboard_id, widget_id)
        self.repository.delete_widget(widget)
        self.repository.db.commit()
        return DeleteDraftWidgetResponse(ok=True, deleted_widget_id=widget_id)

    def save_draft_layouts(self, dashboard_id: str, request: SaveDraftLayoutsRequest, actor: ActorContext | None = None) -> OkResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        revision = self._get_draft_revision_or_raise(dashboard_id)
        page = self._get_draft_page_or_raise(revision, request.page_id)
        for layout in request.layouts:
            widget = self._get_draft_widget_or_raise(dashboard_id, layout.widget_id)
            if widget.page_id != page.id:
                self._raise_widget_not_found(layout.widget_id)
            self.repository.update_widget_layout(widget, self._layout_to_json(layout))
        self.repository.db.commit()
        return OkResponse(ok=True)

    def publish_dashboard(self, dashboard_id: str, actor: ActorContext | None = None) -> PublishDashboardResponse:
        self._require_dashboard_permission(dashboard_id, actor or ActorContext(), "manage")
        draft_revision = self._get_draft_revision_or_raise(dashboard_id)
        published_revision = self.repository.copy_revision(draft_revision, DashboardRuntimeMode.PUBLISHED)
        published_revision_id = published_revision.id
        published_at = published_revision.published_at or datetime.now(UTC)
        self.repository.update_dashboard_published_metadata(dashboard_id, published_revision_id, published_at)
        append_dashboard_published_event(
            self.repository.db, dashboard_id, published_revision_id,
            published_revision.version, published_at,
        )
        self.repository.db.commit()
        return PublishDashboardResponse(
            dashboard_id=dashboard_id,
            published_revision_id=published_revision_id,
            published_at=dashboard_datetime_to_iso(published_at) or published_at.isoformat(),
        )

    def _build_runtime_response(
        self,
        dashboard_meta: DashboardRuntimeMetaRecord,
        mode: DashboardRuntimeMode,
        revision: DashboardRevisionModel | None,
        actor: ActorContext,
        dashboard_card: DashboardCard,
        *,
        include_data: bool = True,
    ) -> DashboardRuntimeResponse:
        snapshot_event_cursor = published_snapshot_event_cursor(self.repository.db, mode)
        has_published_revision = (
            dashboard_meta.has_published_revision
            or (mode == DashboardRuntimeMode.PUBLISHED and revision is not None)
            or self.repository.get_published_revision(dashboard_meta.id) is not None
        )
        if revision is None:
            return DashboardRuntimeResponse(
                dashboard=self._dashboard_meta_to_schema(dashboard_meta, has_published_revision, actor, dashboard_card),
                mode=mode,
                revision=None,
                event_cursor=snapshot_event_cursor,
                pages=[],
                widgets_by_page_id={},
                filters=[],
            )

        pages = self.repository.list_pages(revision.id)
        widgets_by_page_id = self.repository.list_widgets_by_page_ids([page.id for page in pages])

        sessions: dict[str, DashboardDatasetQuerySession] = {}
        session_errors: dict[str, tuple[str, str]] = {}
        catalog_payloads: dict[str, dict[str, Any] | None] = {}
        result_cache: dict[str, dict[str, Any]] = {}
        remote_budget = DashboardRemoteScanBudget.from_environment()
        runtime_api_path = (
            f"/api/dashboards/{dashboard_meta.id}/published"
            if mode == DashboardRuntimeMode.PUBLISHED
            else f"/api/dashboards/{dashboard_meta.id}/draft/ensure"
        )
        runtime_http_method = "GET" if mode == DashboardRuntimeMode.PUBLISHED else "POST"
        try:
            return DashboardRuntimeResponse(
                dashboard=self._dashboard_meta_to_schema(dashboard_meta, has_published_revision, actor, dashboard_card),
                mode=mode,
                revision=self._revision_to_schema(revision),
                event_cursor=snapshot_event_cursor,
                pages=[self._page_to_schema(page) for page in pages],
                widgets_by_page_id={
                    page_id: [
                        self._widget_to_schema(
                            widget,
                            sessions,
                            session_errors,
                            catalog_payloads,
                            result_cache,
                            actor=actor,
                            remote_budget=remote_budget,
                            api_path=runtime_api_path,
                            http_method=runtime_http_method,
                            include_data=include_data,
                        )
                        for widget in widgets
                    ]
                    for page_id, widgets in widgets_by_page_id.items()
                },
                filters=[],
            )
        finally:
            for session in sessions.values():
                session.close()

    def _build_widget_mutation_response(
        self,
        dashboard_id: str,
        widget: DashboardWidgetModel,
        actor: ActorContext,
        *,
        api_path: str,
        http_method: str,
    ) -> DashboardWidgetMutationResponse:
        """Return only the saved widget so callers do not reload the entire draft."""
        sessions: dict[str, DashboardDatasetQuerySession] = {}
        try:
            runtime_widget = self._widget_to_schema(
                widget,
                sessions,
                {},
                {},
                {},
                actor=actor,
                remote_budget=DashboardRemoteScanBudget.from_environment(),
                api_path=api_path,
                http_method=http_method,
                include_data=False,
            )
        finally:
            for session in sessions.values():
                session.close()
        return DashboardWidgetMutationResponse(id=widget.id, widget=runtime_widget)

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

    def _require_dashboard_permission(self, dashboard_id: str, actor: ActorContext, action: str) -> DashboardCard:
        dashboard = get_dashboard_card(self.repository.db, dashboard_id)
        if dashboard is None:
            self._raise_dashboard_not_found(dashboard_id)
        grants = dashboard.permission_grants or permission_grants_from_roles(dashboard.owner, default_actions=["view", "manage", "share"])
        dashboard = dashboard_with_persisted_permission_grants(
            self.repository.db,
            dashboard.model_copy(update={"permission_grants": grants}),
        )
        require_governed_access(
            self.repository.db,
            actor,
            action=action,
            api_path=f"/api/dashboards/{dashboard_id}",
            http_method="GET" if action == "view" else "POST",
            metadata={"owner": dashboard.owner},
            resource_id=dashboard.id,
            resource_name=dashboard.name,
            resource_type="dashboard",
        )
        try:
            require_permission(
                actor,
                action,
                owner=dashboard.owner,
                grants=dashboard.permission_grants,
                resource_label="dashboard",
            )
        except ApiError as exc:
            safe_record_audit_event(
                self.repository.db,
                action="dashboard.access.forbidden",
                actor=actor,
                api_path=f"/api/dashboards/{dashboard_id}",
                http_method="GET" if action == "view" else "POST",
                metadata={"owner": dashboard.owner, "requiredAction": action},
                result="forbidden",
                status_code=exc.status_code,
                target_id=dashboard.id,
                target_name=dashboard.name,
                target_type="dashboard",
            )
            raise
        return dashboard

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

    def _dashboard_meta_to_schema(
        self,
        record: DashboardRuntimeMetaRecord,
        has_published_revision: bool,
        actor: ActorContext,
        dashboard_card: DashboardCard,
    ) -> DashboardMeta:
        status_value = DashboardStatus.PUBLISHED if has_published_revision else record.status
        grants = dashboard_card.permission_grants or permission_grants_from_roles(dashboard_card.owner, default_actions=["view", "manage", "share"])
        dashboard_card = dashboard_with_persisted_permission_grants(
            self.repository.db,
            dashboard_card.model_copy(update={"permission_grants": grants}),
        )
        return DashboardMeta(
            id=record.id,
            title=record.title,
            status=status_value,
            permission_grants=dashboard_card.permission_grants,
            permissions=permissions_for_actor_with_governance(
                self.repository.db,
                actor,
                owner=dashboard_card.owner,
                grants=[
                    grant.model_dump(by_alias=True) if hasattr(grant, "model_dump") else grant
                    for grant in dashboard_card.permission_grants
                ],
                resource_id=dashboard_card.id,
                resource_type="dashboard",
            ),
            has_published_revision=has_published_revision,
            updated_at=dashboard_datetime_to_iso(record.updated_at),
        )

    @staticmethod
    def _revision_to_schema(revision: DashboardRevisionModel) -> DashboardRevision:
        return DashboardRevision(
            id=revision.id,
            kind=DashboardRuntimeMode(revision.kind),
            version=revision.version,
            published_at=dashboard_datetime_to_iso(revision.published_at),
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

    def _widget_to_schema(
        self,
        widget: DashboardWidgetModel,
        sessions: dict[str, DashboardDatasetQuerySession],
        session_errors: dict[str, tuple[str, str]],
        catalog_payloads: dict[str, dict[str, Any] | None],
        result_cache: dict[str, dict[str, Any]],
        *,
        actor: ActorContext,
        remote_budget: DashboardRemoteScanBudget,
        api_path: str,
        http_method: str,
        include_data: bool = True,
        use_live_results: bool = True,
    ) -> DashboardRuntimeWidget:
        widget_type = DashboardRuntimeWidgetType(widget.type)
        config = self._normalize_widget_config(widget_type, widget.config)
        data = list(widget.data or [])[:MAX_EXPLICIT_WIDGET_ROWS]
        is_live_widget = bool(
            widget.dataset_id
            and self.live_repository is not None
            and self._continuous_job(widget.dataset_id) is not None
        )
        if not include_data and widget.dataset_id:
            return DashboardRuntimeWidget(
                id=widget.id,
                page_id=widget.page_id,
                type=widget_type,
                title=widget.title,
                layout=DashboardWidgetLayout(**widget.layout),
                config=config,
                data=[],
                dataset_id=widget.dataset_id,
                query_id=widget.query_id,
                live_refresh=is_live_widget,
                data_status="pending",
            )
        if (
            is_live_widget
            and use_live_results
        ):
            return self._live_widget_to_schema(
                widget,
                session_errors,
                catalog_payloads,
                actor=actor,
                remote_budget=remote_budget,
                api_path=api_path,
                http_method=http_method,
            )
        if widget.dataset_id:
            if widget.dataset_id not in catalog_payloads:
                catalog_payloads[widget.dataset_id] = self.catalog_repository.get_dataset_payload(widget.dataset_id)
            payload = catalog_payloads[widget.dataset_id]
            if payload is None:
                if not widget.query_id:
                    config = {
                        **config,
                        "error": DASHBOARD_DATA_UNAVAILABLE,
                        "errorMessage": "The Catalog dataset linked to this widget is no longer available.",
                    }
                    data = []
            else:
                cache_key = "|".join((
                    widget.dataset_id,
                    widget_type.value,
                    json.dumps(config, ensure_ascii=True, sort_keys=True, default=str),
                ))
                result = result_cache.get(cache_key)
                if result is None and widget.dataset_id not in session_errors:
                    session = sessions.get(widget.dataset_id)
                    if session is None:
                        try:
                            dataset = dataset_with_persisted_permission_grants(
                                self.catalog_repository.db,
                                CatalogDatasetResponse.model_validate(payload),
                            )
                            require_dashboard_dataset_query_access(
                                self.catalog_repository.db,
                                actor,
                                dataset,
                                api_path=api_path,
                                http_method=http_method,
                            )
                        except ApiError as exc:
                            if exc.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN}:
                                session_errors[widget.dataset_id] = (
                                    DASHBOARD_DATA_FORBIDDEN,
                                    "You do not have permission to query this widget's dataset.",
                                )
                            else:
                                session_errors[widget.dataset_id] = (
                                    DASHBOARD_DATA_UNAVAILABLE,
                                    "Dashboard widget data could not be read from physical storage.",
                                )
                        except ValidationError:
                            session_errors[widget.dataset_id] = (
                                DASHBOARD_DATA_UNAVAILABLE,
                                "Dashboard widget data could not be read from physical storage.",
                            )
                        if widget.dataset_id not in session_errors:
                            try:
                                session = DashboardDatasetQuerySession(
                                    payload,
                                    remote_budget=remote_budget,
                                )
                            except (ApiError, ValueError):
                                session_errors[widget.dataset_id] = (
                                    DASHBOARD_DATA_UNAVAILABLE,
                                    "Dashboard widget data could not be read from physical storage.",
                                )
                        if session is not None:
                            sessions[widget.dataset_id] = session
                    if session is not None:
                        try:
                            result = session.read_widget(widget_type.value, config)
                            result_cache[cache_key] = result
                        except (ApiError, ValueError):
                            result = None
                if result is not None:
                    config = result["config"]
                    data = result["data"]
                else:
                    error_code, error_message = session_errors.get(
                        widget.dataset_id,
                        (
                            DASHBOARD_DATA_UNAVAILABLE,
                            "Dashboard widget data could not be read from physical storage.",
                        ),
                    )
                    config = {
                        **config,
                        "error": error_code,
                        "errorMessage": error_message,
                    }
                    data = []
        return DashboardRuntimeWidget(
            id=widget.id,
            page_id=widget.page_id,
            type=widget_type,
            title=widget.title,
            layout=DashboardWidgetLayout(**widget.layout),
            config=config,
            data=data,
            dataset_id=widget.dataset_id,
            query_id=widget.query_id,
            data_status="error" if config.get("error") else "ready",
            data_error=str(config.get("errorMessage")) if config.get("errorMessage") else None,
        )

    def _continuous_job(self, dataset_id: str) -> object | None:
        if dataset_id not in self._continuous_job_cache:
            self._continuous_job_cache[dataset_id] = (
                self.live_repository.continuous_job_by_dataset(dataset_id)
                if self.live_repository is not None
                else None
            )
        return self._continuous_job_cache[dataset_id]

    def _live_widget_to_schema(
        self,
        widget: DashboardWidgetModel,
        session_errors: dict[str, tuple[str, str]],
        catalog_payloads: dict[str, dict[str, Any] | None],
        *,
        actor: ActorContext,
        remote_budget: DashboardRemoteScanBudget,
        api_path: str,
        http_method: str,
    ) -> DashboardRuntimeWidget:
        widget_type = DashboardRuntimeWidgetType(widget.type)
        config = self._normalize_widget_config(widget_type, widget.config)
        dataset_id = str(widget.dataset_id)
        # ETL publishes Catalog metadata and freshness in one transaction while
        # locking Catalog first. Use the same lock order so a widget can never
        # pair an old S3 run list with a newer applied revision.
        payload = self.catalog_repository.get_dataset_payload_for_update(dataset_id)
        catalog_payloads[dataset_id] = payload
        if payload is None:
            return self._live_widget_response(
                widget,
                config={
                    **config,
                    "error": DASHBOARD_DATA_UNAVAILABLE,
                    "errorMessage": "The Catalog dataset linked to this widget is no longer available.",
                },
                data=[],
            )

        freshness = self.live_repository.get_freshness(dataset_id, for_update=True)
        latest_revision = int(freshness.latest_revision or 0) if freshness is not None else 0

        if dataset_id not in session_errors:
            try:
                dataset = dataset_with_persisted_permission_grants(
                    self.catalog_repository.db,
                    CatalogDatasetResponse.model_validate(payload),
                )
                require_dashboard_dataset_query_access(
                    self.catalog_repository.db,
                    actor,
                    dataset,
                    api_path=api_path,
                    http_method=http_method,
                )
            except ApiError as exc:
                session_errors[dataset_id] = (
                    DASHBOARD_DATA_FORBIDDEN,
                    "You do not have permission to query this widget's dataset.",
                ) if exc.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN} else (
                    DASHBOARD_DATA_UNAVAILABLE,
                    "Dashboard widget data could not be read from physical storage.",
                )
            except ValidationError:
                session_errors[dataset_id] = (
                    DASHBOARD_DATA_UNAVAILABLE,
                    "Dashboard widget data could not be read from physical storage.",
                )
        if dataset_id in session_errors:
            error_code, error_message = session_errors[dataset_id]
            return self._live_widget_response(
                widget,
                config={**config, "error": error_code, "errorMessage": error_message},
                data=[],
            )

        calculation_version = self._widget_calculation_version(
            widget_type,
            dataset_id,
            config,
            schema_identity=payload.get("schemaFingerprint") or payload.get("schema"),
        )
        saved = self.live_repository.get_widget_result(
            widget.id,
            calculation_version,
            for_update=True,
        )
        saved_payload = dict(saved.result_payload or {}) if saved is not None else None
        saved_state = dict(saved.calculation_state or {}) if saved is not None else None
        saved_revision = int(saved.applied_revision or 0) if saved is not None else None
        saved_calculated_at = saved.calculated_at if saved is not None else None
        source_config = dashboard_source_config(config)
        if saved is not None and int(saved.applied_revision or 0) >= latest_revision:
            self.live_repository.db.commit()
            return self._live_widget_response(
                widget,
                config=dict(saved_payload.get("config") or config),
                data=list(saved_payload.get("data") or []),
                applied_revision=int(saved.applied_revision or 0),
                calculation_version=calculation_version,
                calculated_at=saved_calculated_at,
            )

        computed_result: dict[str, Any] | None = None
        computed_state: dict[str, Any] = {}
        calculation_mode = "full"
        applied_revision = latest_revision
        calculation_started_at = time.perf_counter()
        try:
            if (
                latest_revision > (int(saved.applied_revision or 0) if saved is not None else 0)
                and saved is not None
                and bool(saved_state)
                and dashboard_widget_supports_incremental_merge(widget_type.value, source_config)
            ):
                incremental = self._incremental_widget_result(
                    payload,
                    widget_type,
                    config,
                    saved_state,
                    dataset_id=dataset_id,
                    after_revision=int(saved.applied_revision or 0) if saved is not None else 0,
                    remote_budget=remote_budget,
                )
                if incremental is not None:
                    computed_result, computed_state, applied_revision, calculation_mode = incremental
            if computed_result is None:
                computed_result, computed_state = self._full_widget_result(
                    payload,
                    widget_type,
                    config,
                    remote_budget=remote_budget,
                )
                calculation_mode = "full"

            persisted = self.live_repository.save_widget_result(
                widget_id=widget.id,
                calculation_version=calculation_version,
                dataset_id=dataset_id,
                applied_revision=applied_revision,
                result_payload=computed_result,
                calculation_state=computed_state,
                calculation_mode=calculation_mode,
            )
            calculated_at = persisted.calculated_at
            self.live_repository.db.commit()
            logger.info(
                "dashboard_widget_result_calculated widget_id=%s dataset_id=%s applied_revision=%s mode=%s duration_ms=%s",
                widget.id,
                dataset_id,
                applied_revision,
                calculation_mode,
                round((time.perf_counter() - calculation_started_at) * 1000),
            )
            return self._live_widget_response(
                widget,
                config=dict(computed_result.get("config") or config),
                data=list(computed_result.get("data") or []),
                applied_revision=applied_revision,
                calculation_version=calculation_version,
                calculated_at=calculated_at,
            )
        except Exception as exc:
            self.live_repository.db.rollback()
            winner = self.live_repository.get_widget_result(widget.id, calculation_version)
            if winner is not None and int(winner.applied_revision or 0) > int(saved_revision or -1):
                winner_payload = dict(winner.result_payload or {})
                return self._live_widget_response(
                    widget,
                    config=dict(winner_payload.get("config") or config),
                    data=list(winner_payload.get("data") or []),
                    applied_revision=int(winner.applied_revision or 0),
                    calculation_version=calculation_version,
                    calculated_at=winner.calculated_at,
                )
            logger.warning(
                "dashboard_widget_result_failed widget_id=%s dataset_id=%s target_revision=%s error=%s",
                widget.id,
                dataset_id,
                latest_revision,
                str(exc)[:500],
            )
            if saved_payload is not None:
                return self._live_widget_response(
                    widget,
                    config=dict(saved_payload.get("config") or config),
                    data=list(saved_payload.get("data") or []),
                    applied_revision=saved_revision,
                    calculation_version=calculation_version,
                    calculated_at=saved_calculated_at,
                )
            previous = self.live_repository.latest_widget_result(widget.id, dataset_id)
            if previous is not None:
                previous_payload = dict(previous.result_payload or {})
                return self._live_widget_response(
                    widget,
                    config=dict(previous_payload.get("config") or config),
                    data=list(previous_payload.get("data") or []),
                    applied_revision=int(previous.applied_revision or 0),
                    calculation_version=str(previous.calculation_version),
                    calculated_at=previous.calculated_at,
                )
            if computed_result is not None:
                return self._live_widget_response(
                    widget,
                    config=dict(computed_result.get("config") or config),
                    data=list(computed_result.get("data") or []),
                    calculation_version=calculation_version,
                )
            return self._live_widget_response(
                widget,
                config={
                    **config,
                    "error": DASHBOARD_DATA_UNAVAILABLE,
                    "errorMessage": "Dashboard widget data could not be read from physical storage.",
                },
                data=[],
                calculation_version=calculation_version,
            )

    def _full_widget_result(
        self,
        payload: dict[str, Any],
        widget_type: DashboardRuntimeWidgetType,
        config: dict[str, Any],
        *,
        remote_budget: DashboardRemoteScanBudget,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        session = DashboardDatasetQuerySession(payload, remote_budget=remote_budget)
        try:
            state = session.read_aggregate_state(widget_type.value, config)
            if state is not None:
                return dashboard_result_from_aggregate_state(state), state
            return session.read_widget(widget_type.value, config), {}
        finally:
            session.close()

    def _incremental_widget_result(
        self,
        payload: dict[str, Any],
        widget_type: DashboardRuntimeWidgetType,
        config: dict[str, Any],
        current_state: dict[str, Any] | None,
        *,
        dataset_id: str,
        after_revision: int,
        remote_budget: DashboardRemoteScanBudget,
    ) -> tuple[dict[str, Any], dict[str, Any], int, str] | None:
        if not dashboard_widget_supports_incremental_merge(
            widget_type.value,
            dashboard_source_config(config),
        ):
            return None
        commits = self.live_repository.list_commits(
            dataset_id,
            after_revision=after_revision,
            through_revision=after_revision + 1,
        )
        expected_revisions = [after_revision + 1]
        if (
            [int(commit.revision) for commit in commits] != expected_revisions
            or widget_type == DashboardRuntimeWidgetType.TABLE
        ):
            return None
        commit = commits[0]
        materialization_mode = str(commit.materialization_mode or "").strip().lower()
        commit_kind = str(
            getattr(commit, "commit_kind", LEGACY_COMMIT_KIND) or LEGACY_COMMIT_KIND
        ).strip().lower()
        if (
            materialization_mode != "delta"
            or commit_kind in {BACKFILL_COMMIT_KIND, LEGACY_COMMIT_KIND}
            or not current_state
        ):
            return None
        delta_payload = dict(payload)
        delta_payload["materializationRuns"] = [
            {
                "materializationMode": commit.materialization_mode,
                "rowCount": commit.row_count,
                "runId": commit.run_id,
                "sourceKind": "kafka",
                "status": "success",
                "storageFormat": commit.storage_format,
                "storageLocation": commit.storage_location,
            }
            for commit in reversed(commits)
        ]
        iceberg_run_id = (
            str(commit.run_id)
            if str(commit.storage_format or "").strip().lower() == "iceberg"
            else None
        )
        session = DashboardDatasetQuerySession(
            delta_payload,
            remote_budget=remote_budget,
            iceberg_run_id=iceberg_run_id,
        )
        try:
            if iceberg_run_id is not None and not session.revision_delta_available:
                return None
            delta_state = session.read_aggregate_state(widget_type.value, config)
        finally:
            session.close()
        if delta_state is None:
            return None
        if int(commit.row_count or 0) > 0 and not any(
            isinstance(row, dict) for row in (delta_state.get("rows") or [])
        ):
            logger.warning(
                "dashboard_widget_revision_delta_empty dataset_id=%s revision=%s run_id=%s row_count=%s; falling back to full calculation",
                dataset_id,
                commit.revision,
                commit.run_id,
                commit.row_count,
            )
            return None
        merged_state = merge_dashboard_aggregate_states(current_state, delta_state)
        if merged_state is None:
            return None
        return (
            dashboard_result_from_aggregate_state(merged_state),
            merged_state,
            int(commit.revision),
            "incremental",
        )

    @staticmethod
    def _widget_calculation_version(
        widget_type: DashboardRuntimeWidgetType,
        dataset_id: str,
        config: dict[str, Any],
        *,
        schema_identity: Any = None,
    ) -> str:
        canonical = json.dumps(
            {
                "contractVersion": 2,
                "datasetId": dataset_id,
                "schemaIdentity": schema_identity,
                "sourceConfig": dashboard_source_config(config),
                "widgetType": widget_type.value,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _live_widget_response(
        self,
        widget: DashboardWidgetModel,
        *,
        config: dict[str, Any],
        data: list[dict[str, Any]],
        applied_revision: int | None = None,
        calculation_version: str | None = None,
        calculated_at: datetime | None = None,
    ) -> DashboardRuntimeWidget:
        return DashboardRuntimeWidget(
            id=widget.id,
            page_id=widget.page_id,
            type=DashboardRuntimeWidgetType(widget.type),
            title=widget.title,
            layout=DashboardWidgetLayout(**widget.layout),
            config=config,
            data=data,
            dataset_id=widget.dataset_id,
            query_id=widget.query_id,
            applied_revision=applied_revision,
            calculation_version=calculation_version,
            calculated_at=dashboard_datetime_to_iso(calculated_at),
            live_refresh=True,
            data_status="error" if config.get("error") else "ready",
            data_error=str(config.get("errorMessage")) if config.get("errorMessage") else None,
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
        payload = resolved_config.model_dump(by_alias=True, exclude_none=True, mode="json")
        source_config = payload.pop("sourceConfig", None)
        payload.pop("dataMode", None)
        if not isinstance(source_config, dict):
            return payload

        persisted_config = dict(source_config)
        for key in (
            "body",
            "color",
            "description",
            "placeholderKind",
            "prompt",
        ):
            if key in payload:
                persisted_config[key] = payload[key]
        return persisted_config

    @staticmethod
    def _normalize_widget_config(
        widget_type: DashboardRuntimeWidgetType,
        config: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if config is None:
            return DashboardRuntimeService._config_to_json(widget_type, None)

        normalized = dict(config)
        if widget_type in {DashboardRuntimeWidgetType.METRIC, DashboardRuntimeWidgetType.TABLE}:
            return normalized

        color = normalized.get("color")
        if isinstance(color, str):
            record_compatibility_path(
                CompatibilityPath.DASHBOARD_LEGACY_COLOR,
                reason="legacy scalar widget color is being normalized",
                context={"color": color},
            )
            normalized["color"] = {
                "colors": [
                    DASHBOARD_LEGACY_COLOR_MAP.get(
                        color,
                        color if color.startswith("#") else "#2563eb",
                    ),
                ],
            }
        elif color is None:
            normalized["color"] = {"colors": ["#2563eb"]}

        return normalized

    def _resolve_widget_data(
        self,
        explicit_data: list[dict[str, Any]] | None,
        dataset_id: str | None,
    ) -> list[dict[str, Any]]:
        if dataset_id and self.catalog_repository.get_dataset_payload(dataset_id) is not None:
            return []
        if explicit_data is not None:
            return explicit_data[:MAX_EXPLICIT_WIDGET_ROWS]
        return []

    @staticmethod
    def _default_config(widget_type: DashboardRuntimeWidgetType) -> DashboardWidgetConfigBase:
        color = DashboardWidgetColorConfig(colors=["#2563eb"])
        if widget_type == DashboardRuntimeWidgetType.METRIC:
            return MetricWidgetConfig(
                aggregation=DashboardWidgetAggregation.COUNT,
                format=DashboardWidgetFormat.NUMBER,
                value_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.TABLE:
            return TableWidgetConfig(columns=[])
        if widget_type == DashboardRuntimeWidgetType.LINE_CHART:
            return LineChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                curve=DashboardWidgetLineCurve.SMOOTH,
                x_key="category",
                y_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.AREA_CHART:
            return AreaChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                stacked=False,
                x_key="category",
                y_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.DONUT_CHART:
            return DonutChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                label_key="category",
                value_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.PIE_CHART:
            return PieChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                label_key="category",
                value_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.RADIAL_BAR_CHART:
            return RadialBarChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.AVG,
                color=color,
                format=DashboardWidgetFormat.PERCENT,
                max=100,
                min=0,
                value_key="value",
            )
        if widget_type == DashboardRuntimeWidgetType.HEATMAP_CHART:
            return HeatmapChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                value_key="value",
                x_key="category",
                y_key="series",
            )
        if widget_type == DashboardRuntimeWidgetType.TREEMAP_CHART:
            return TreemapChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=color,
                label_key="category",
                value_key="value",
            )
        return BarChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            orientation=DashboardWidgetOrientation.VERTICAL,
            x_key="category",
            y_key="value",
        )
