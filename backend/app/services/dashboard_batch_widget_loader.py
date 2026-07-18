from dataclasses import dataclass
from datetime import datetime
import logging
import time
from typing import Any

from fastapi import status
from pydantic import ValidationError

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.core.observability import increment_metric, log_event
from app.repositories.dashboard_batch_result_repository import DashboardBatchResultRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.dashboard import DashboardRuntimeWidgetType
from app.services.dashboard_batch_cache import dashboard_batch_cache_identity
from app.services.dashboard_dataset_access import require_dashboard_dataset_query_access
from app.services.dashboard_physical_data import DashboardDatasetQuerySession, DashboardRemoteScanBudget
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


DASHBOARD_DATA_FORBIDDEN = "DASHBOARD_DATA_FORBIDDEN"
DASHBOARD_DATA_UNAVAILABLE = "DASHBOARD_DATA_UNAVAILABLE"
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DashboardBatchWidgetLoadResult:
    calculated_at: datetime | None
    calculation_version: str | None
    config: dict[str, Any]
    data: list[dict[str, Any]]


class DashboardBatchWidgetLoader:
    def __init__(
        self,
        catalog_repository: Any,
        batch_result_repository: DashboardBatchResultRepository | None,
    ) -> None:
        self.catalog_repository = catalog_repository
        self.batch_result_repository = batch_result_repository
        self._authorized_dataset_scopes: set[tuple[str, str]] = set()

    def load(
        self,
        *,
        actor: ActorContext,
        api_path: str,
        config: dict[str, Any],
        dashboard_id: str | None,
        dataset_id: str,
        http_method: str,
        page_id: str,
        payload: dict[str, Any],
        remote_budget: DashboardRemoteScanBudget,
        request_cache: dict[str, dict[str, Any]],
        session_errors: dict[str, tuple[str, str]],
        sessions: dict[str, DashboardDatasetQuerySession],
        widget_id: str,
        widget_type: DashboardRuntimeWidgetType,
    ) -> DashboardBatchWidgetLoadResult:
        started_at = time.perf_counter()
        identity = dashboard_batch_cache_identity(payload, widget_type, config, actor)
        request_cache_key = "|".join((dataset_id, widget_type.value, identity.config_hash))
        access_scope = (dataset_id, identity.actor_scope_hash)

        if access_scope not in self._authorized_dataset_scopes and dataset_id not in session_errors:
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
                self._authorized_dataset_scopes.add(access_scope)
            except ApiError as exc:
                session_errors[dataset_id] = (
                    DASHBOARD_DATA_FORBIDDEN,
                    "You do not have permission to query this widget's dataset.",
                ) if exc.status_code in {
                    status.HTTP_401_UNAUTHORIZED,
                    status.HTTP_403_FORBIDDEN,
                } else (
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
            self._record(
                started_at,
                api_path=api_path,
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                error_code=error_code,
                page_id=page_id,
                result="error",
                stage="permission" if error_code == DASHBOARD_DATA_FORBIDDEN else "metadata",
                widget_id=widget_id,
            )
            return DashboardBatchWidgetLoadResult(
                calculated_at=None,
                calculation_version=None,
                config={**config, "error": error_code, "errorMessage": error_message},
                data=[],
            )

        request_entry = request_cache.get(request_cache_key)
        if request_entry is not None:
            result = dict(request_entry.get("result") or {})
            self._record(
                started_at,
                api_path=api_path,
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                page_id=page_id,
                result="hit",
                stage="request_cache",
                widget_id=widget_id,
            )
            return DashboardBatchWidgetLoadResult(
                calculated_at=request_entry.get("calculatedAt"),
                calculation_version=str(request_entry.get("calculationVersion") or "") or None,
                config=dict(result.get("config") or config),
                data=list(result.get("data") or []),
            )

        if self.batch_result_repository is not None:
            cached = self.batch_result_repository.get(identity.cache_key)
            cached_payload = dict(cached.result_payload or {}) if cached is not None else {}
            cached_config = cached_payload.get("config")
            cached_data = cached_payload.get("data")
            if isinstance(cached_config, dict) and isinstance(cached_data, list):
                result = {"config": cached_config, "data": cached_data}
                request_cache[request_cache_key] = {
                    "calculatedAt": cached.calculated_at,
                    "calculationVersion": identity.cache_key,
                    "result": result,
                }
                self._record(
                    started_at,
                    api_path=api_path,
                    dashboard_id=dashboard_id,
                    dataset_id=dataset_id,
                    page_id=page_id,
                    result="hit",
                    stage="postgres_cache",
                    widget_id=widget_id,
                )
                return DashboardBatchWidgetLoadResult(
                    calculated_at=cached.calculated_at,
                    calculation_version=identity.cache_key,
                    config=cached_config,
                    data=cached_data,
                )

        session = sessions.get(dataset_id)
        if session is None:
            try:
                session = DashboardDatasetQuerySession(payload, remote_budget=remote_budget)
            except (ApiError, ValueError):
                session_errors[dataset_id] = (
                    DASHBOARD_DATA_UNAVAILABLE,
                    "Dashboard widget data could not be read from physical storage.",
                )
            if session is not None:
                sessions[dataset_id] = session

        result: dict[str, Any] | None = None
        if session is not None:
            try:
                result = session.read_widget(widget_type.value, config)
            except (ApiError, ValueError):
                result = None
        if result is None:
            error_code, error_message = session_errors.get(
                dataset_id,
                (
                    DASHBOARD_DATA_UNAVAILABLE,
                    "Dashboard widget data could not be read from physical storage.",
                ),
            )
            self._record(
                started_at,
                api_path=api_path,
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                error_code=error_code,
                page_id=page_id,
                result="error",
                stage="physical_query",
                widget_id=widget_id,
            )
            return DashboardBatchWidgetLoadResult(
                calculated_at=None,
                calculation_version=None,
                config={**config, "error": error_code, "errorMessage": error_message},
                data=[],
            )

        calculated_at = None
        if self.batch_result_repository is not None:
            calculated_at = self.batch_result_repository.save(
                cache_key=identity.cache_key,
                dataset_id=dataset_id,
                dataset_version=identity.dataset_version,
                widget_type=widget_type.value,
                config_hash=identity.config_hash,
                actor_scope_hash=identity.actor_scope_hash,
                result_payload=result,
            )
            self.batch_result_repository.db.commit()
        request_cache[request_cache_key] = {
            "calculatedAt": calculated_at,
            "calculationVersion": identity.cache_key,
            "result": result,
        }
        self._record(
            started_at,
            api_path=api_path,
            dashboard_id=dashboard_id,
            dataset_id=dataset_id,
            page_id=page_id,
            result="miss",
            stage="physical_query",
            widget_id=widget_id,
        )
        return DashboardBatchWidgetLoadResult(
            calculated_at=calculated_at,
            calculation_version=identity.cache_key,
            config=dict(result["config"]),
            data=list(result["data"]),
        )

    @staticmethod
    def _record(
        started_at: float,
        *,
        api_path: str,
        dashboard_id: str | None,
        dataset_id: str,
        page_id: str,
        result: str,
        stage: str,
        widget_id: str,
        error_code: str | None = None,
    ) -> None:
        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
        increment_metric(
            "dashboard_widget_data_total",
            result=result,
            stage=stage,
        )
        log_event(
            logger,
            "dashboard_widget_data",
            apiPath=api_path,
            dashboardId=dashboard_id,
            datasetId=dataset_id,
            durationMs=duration_ms,
            errorCode=error_code,
            pageId=page_id,
            result=result,
            stage=stage,
            widgetId=widget_id,
        )
