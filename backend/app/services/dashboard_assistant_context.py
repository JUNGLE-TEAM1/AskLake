from dataclasses import dataclass, field
from typing import Any

from app.models.dashboard_runtime import DashboardWidget as DashboardWidgetModel
from app.repositories.catalog_repository import CatalogRepository, dataset_model_to_payload
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.dashboard import (
    DashboardAssistantRequest,
    DashboardAssistantWidgetContext,
    DashboardRuntimeMode,
    DashboardRuntimeWidgetType,
)
from app.services.dashboard_assistant_options import widget_options_payload
from app.services.dashboard_runtime_service import DashboardRuntimeService


@dataclass(frozen=True)
class AssistantColumnContext:
    name: str
    type: str

    def to_prompt_payload(self) -> dict[str, str]:
        return {"name": self.name, "type": self.type}


@dataclass(frozen=True)
class AssistantDatasetContext:
    id: str
    name: str
    layer: str
    description: str
    columns: list[AssistantColumnContext]
    sample_rows: list[dict[str, Any]]
    tags: list[str]

    def to_prompt_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "layer": self.layer,
            "description": self.description,
            "columns": [column.to_prompt_payload() for column in self.columns],
            "sampleRows": self.sample_rows,
            "tags": self.tags,
        }


@dataclass(frozen=True)
class AssistantWidgetContext:
    id: str
    title: str
    type: DashboardRuntimeWidgetType
    dataset_id: str | None
    config: dict[str, Any]
    data_sample: list[dict[str, Any]]

    def to_prompt_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "type": self.type.value,
            "datasetId": self.dataset_id,
            "config": self.config,
            "dataSample": self.data_sample,
        }


@dataclass(frozen=True)
class AssistantPageContext:
    id: str | None = None
    title: str | None = None

    def to_prompt_payload(self) -> dict[str, str | None]:
        return {"id": self.id, "title": self.title}


@dataclass(frozen=True)
class AssistantDashboardContext:
    id: str | None
    title: str | None = None
    page: AssistantPageContext = field(default_factory=AssistantPageContext)
    datasets: list[AssistantDatasetContext] = field(default_factory=list)
    widgets: list[AssistantWidgetContext] = field(default_factory=list)
    widget_options: list[dict[str, Any]] = field(default_factory=widget_options_payload)
    warnings: list[str] = field(default_factory=list)

    def dataset_by_id(self) -> dict[str, AssistantDatasetContext]:
        return {dataset.id: dataset for dataset in self.datasets}

    def widget_by_id(self) -> dict[str, AssistantWidgetContext]:
        return {widget.id: widget for widget in self.widgets}

    def to_prompt_payload(self) -> dict[str, Any]:
        return {
            "dashboard": {"id": self.id, "title": self.title},
            "page": self.page.to_prompt_payload(),
            "availableDatasets": [dataset.to_prompt_payload() for dataset in self.datasets],
            "widgets": [widget.to_prompt_payload() for widget in self.widgets],
            "widgetOptions": self.widget_options,
            "warnings": self.warnings,
        }


def build_assistant_context(
    request: DashboardAssistantRequest,
    runtime_repository: DashboardRuntimeRepository,
    catalog_repository: CatalogRepository,
    *,
    max_sample_rows: int,
) -> AssistantDashboardContext:
    datasets = _available_dataset_contexts(catalog_repository, max_sample_rows)
    dashboard_id = request.dashboard_id
    if not dashboard_id:
        return _request_fallback_context(request, datasets)

    dashboard_meta = runtime_repository.get_dashboard_meta(dashboard_id)
    revision = (
        runtime_repository.get_draft_revision(dashboard_id)
        or runtime_repository.get_published_revision(dashboard_id)
    )
    if revision is None:
        return AssistantDashboardContext(
            id=dashboard_id,
            title=dashboard_meta.title if dashboard_meta else None,
            datasets=datasets,
            warnings=["대시보드 draft/published revision을 찾지 못해 위젯 컨텍스트 없이 진행합니다."],
        )

    pages = runtime_repository.list_pages(revision.id)
    selected_page = _select_page(pages, request.page_id)
    page_ids = [page.id for page in pages]
    widgets_by_page_id = runtime_repository.list_widgets_by_page_ids(page_ids)
    selected_page_widgets = widgets_by_page_id.get(selected_page.id, []) if selected_page else []
    target_widgets, target_warnings = _filter_widgets_for_target(selected_page_widgets, request)

    return AssistantDashboardContext(
        id=dashboard_id,
        title=dashboard_meta.title if dashboard_meta else None,
        page=AssistantPageContext(
            id=selected_page.id if selected_page else request.page_id,
            title=selected_page.title if selected_page else None,
        ),
        datasets=datasets,
        widgets=[
            _widget_model_to_context(widget, max_sample_rows)
            for widget in target_widgets
        ],
        warnings=[
            *target_warnings,
            *([] if datasets else ["대시보드에서 사용할 수 있는 데이터셋을 찾지 못했습니다."]),
        ],
    )


def _select_page(pages: list[Any], page_id: str | None) -> Any | None:
    if page_id:
        return next((page for page in pages if page.id == page_id), None)
    return pages[0] if pages else None


def _target_widget_id(request: DashboardAssistantRequest) -> str | None:
    return request.widget_id or request.selected_widget_id


def _filter_widgets_for_target(
    widgets: list[Any],
    request: DashboardAssistantRequest,
) -> tuple[list[Any], list[str]]:
    target_widget_id = _target_widget_id(request)
    if not target_widget_id:
        return widgets, []

    target_widgets = [
        widget
        for widget in widgets
        if getattr(widget, "id", None) == target_widget_id
    ]
    if target_widgets:
        return target_widgets, []

    return [], [
        f"요청 대상 widgetId {target_widget_id!r}를 현재 page에서 찾지 못해 위젯 컨텍스트를 제한했습니다.",
    ]


def _available_dataset_contexts(
    catalog_repository: CatalogRepository,
    max_sample_rows: int,
) -> list[AssistantDatasetContext]:
    contexts: list[AssistantDatasetContext] = []
    for model in catalog_repository.list_dataset_models():
        try:
            dataset = CatalogDatasetResponse.model_validate(dataset_model_to_payload(model))
        except Exception:
            continue
        if dataset.status != "available" or not dataset.schema_:
            continue
        contexts.append(_dataset_to_context(dataset, max_sample_rows))
    return contexts


def _dataset_to_context(
    dataset: CatalogDatasetResponse,
    max_sample_rows: int,
) -> AssistantDatasetContext:
    columns = [
        AssistantColumnContext(name=str(name), type=str(column_type))
        for name, column_type in dataset.schema_
    ]
    column_names = [column.name for column in columns]
    return AssistantDatasetContext(
        id=dataset.id,
        name=dataset.name,
        layer=dataset.layer,
        description=dataset.description,
        columns=columns,
        sample_rows=_sample_rows_to_objects(dataset.sample_rows, column_names, max_sample_rows),
        tags=dataset.tags,
    )


def _sample_rows_to_objects(
    sample_rows: list[Any],
    column_names: list[str],
    max_sample_rows: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for raw_row in sample_rows[:max_sample_rows]:
        if isinstance(raw_row, dict):
            rows.append(dict(raw_row))
            continue
        if not isinstance(raw_row, list):
            continue
        names = column_names or [f"col_{index + 1}" for index in range(len(raw_row))]
        rows.append({
            names[index] if index < len(names) else f"col_{index + 1}": value
            for index, value in enumerate(raw_row)
        })
    return rows


def _widget_model_to_context(
    widget: DashboardWidgetModel,
    max_sample_rows: int,
) -> AssistantWidgetContext:
    widget_type = DashboardRuntimeWidgetType(widget.type)
    normalized_config = DashboardRuntimeService._normalize_widget_config(widget_type, widget.config)
    config_payload = (
        normalized_config.model_dump(by_alias=True, exclude_none=True, mode="json")
        if hasattr(normalized_config, "model_dump")
        else dict(normalized_config)
    )
    return AssistantWidgetContext(
        id=widget.id,
        title=widget.title or "제목 없는 위젯",
        type=widget_type,
        dataset_id=widget.dataset_id,
        config=config_payload,
        data_sample=list(widget.data or [])[:max_sample_rows],
    )


def _request_fallback_context(
    request: DashboardAssistantRequest,
    datasets: list[AssistantDatasetContext],
) -> AssistantDashboardContext:
    request_widgets, target_warnings = _filter_widgets_for_target(request.widgets, request)
    return AssistantDashboardContext(
        id=request.dashboard_id,
        page=AssistantPageContext(id=request.page_id),
        datasets=datasets,
        widgets=[_request_widget_to_context(widget) for widget in request_widgets],
        warnings=[
            "dashboardId가 없어 요청 payload의 widgets만 사용합니다.",
            *target_warnings,
        ],
    )


def _request_widget_to_context(widget: DashboardAssistantWidgetContext) -> AssistantWidgetContext:
    return AssistantWidgetContext(
        id=widget.id,
        title=widget.title or "제목 없는 위젯",
        type=widget.type,
        dataset_id=widget.dataset_id,
        config=widget.config,
        data_sample=widget.data_sample,
    )
