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
from app.services.dashboard_batch_cache import DashboardBatchCacheIdentity, dashboard_batch_cache_identity
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


@dataclass(frozen=True)
class _DashboardBatchWidgetLoadContext:
    actor: ActorContext
    api_path: str
    config: dict[str, Any]
    dashboard_id: str | None
    dataset_id: str
    http_method: str
    identity: DashboardBatchCacheIdentity
    page_id: str
    payload: dict[str, Any]
    remote_budget: DashboardRemoteScanBudget
    request_cache: dict[str, dict[str, Any]]
    request_cache_key: str
    session_errors: dict[str, tuple[str, str]]
    sessions: dict[str, DashboardDatasetQuerySession]
    started_at: float
    widget_id: str
    widget_type: DashboardRuntimeWidgetType


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
        identity = dashboard_batch_cache_identity(payload, widget_type, config, actor)
        context = _DashboardBatchWidgetLoadContext(
            actor=actor,
            api_path=api_path,
            config=config,
            dashboard_id=dashboard_id,
            dataset_id=dataset_id,
            http_method=http_method,
            identity=identity,
            page_id=page_id,
            payload=payload,
            remote_budget=remote_budget,
            request_cache=request_cache,
            request_cache_key="|".join((dataset_id, widget_type.value, identity.config_hash)),
            session_errors=session_errors,
            sessions=sessions,
            started_at=time.perf_counter(),
            widget_id=widget_id,
            widget_type=widget_type,
        )

        self._authorize(context)
        if dataset_id in session_errors:
            error_code, _ = session_errors[dataset_id]
            stage = "permission" if error_code == DASHBOARD_DATA_FORBIDDEN else "metadata"
            return self._error_result(context, stage)

        for cache_reader in (self._request_cache_result, self._persistent_cache_result):
            cached_result = cache_reader(context)
            if cached_result is not None:
                return cached_result

        result = self._read_physical_result(context)
        if result is None:
            return self._error_result(context, "physical_query")
        return self._store_result(context, result)

    def _authorize(self, context: _DashboardBatchWidgetLoadContext) -> None:
        access_scope = (context.dataset_id, context.identity.actor_scope_hash)
        if access_scope in self._authorized_dataset_scopes:
            return
        if context.dataset_id in context.session_errors:
            return

        try:
            dataset = dataset_with_persisted_permission_grants(
                self.catalog_repository.db,
                CatalogDatasetResponse.model_validate(context.payload),
            )
            require_dashboard_dataset_query_access(
                self.catalog_repository.db,
                context.actor,
                dataset,
                api_path=context.api_path,
                http_method=context.http_method,
            )
            self._authorized_dataset_scopes.add(access_scope)
        except ApiError as exc:
            context.session_errors[context.dataset_id] = (
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
            context.session_errors[context.dataset_id] = (
                DASHBOARD_DATA_UNAVAILABLE,
                "Dashboard widget data could not be read from physical storage.",
            )

    def _error_result(
        self,
        context: _DashboardBatchWidgetLoadContext,
        stage: str,
    ) -> DashboardBatchWidgetLoadResult:
        error_code, error_message = context.session_errors.get(
            context.dataset_id,
            (
                DASHBOARD_DATA_UNAVAILABLE,
                "Dashboard widget data could not be read from physical storage.",
            ),
        )
        self._record_context(
            context,
            error_code=error_code,
            result="error",
            stage=stage,
        )
        return DashboardBatchWidgetLoadResult(
            calculated_at=None,
            calculation_version=None,
            config={**context.config, "error": error_code, "errorMessage": error_message},
            data=[],
        )

    def _request_cache_result(
        self,
        context: _DashboardBatchWidgetLoadContext,
    ) -> DashboardBatchWidgetLoadResult | None:
        request_entry = context.request_cache.get(context.request_cache_key)
        if request_entry is None:
            return None

        result = dict(request_entry.get("result") or {})
        self._record_context(context, result="hit", stage="request_cache")
        return DashboardBatchWidgetLoadResult(
            calculated_at=request_entry.get("calculatedAt"),
            calculation_version=str(request_entry.get("calculationVersion") or "") or None,
            config=dict(result.get("config") or context.config),
            data=list(result.get("data") or []),
        )

    def _persistent_cache_result(
        self,
        context: _DashboardBatchWidgetLoadContext,
    ) -> DashboardBatchWidgetLoadResult | None:
        if self.batch_result_repository is None:
            return None

        cached = self.batch_result_repository.get(context.identity.cache_key)
        cached_payload = dict(cached.result_payload or {}) if cached is not None else {}
        cached_config = cached_payload.get("config")
        cached_data = cached_payload.get("data")
        if cached is None or not isinstance(cached_config, dict) or not isinstance(cached_data, list):
            return None

        result = {"config": cached_config, "data": cached_data}
        context.request_cache[context.request_cache_key] = {
            "calculatedAt": cached.calculated_at,
            "calculationVersion": context.identity.cache_key,
            "result": result,
        }
        self._record_context(context, result="hit", stage="postgres_cache")
        return DashboardBatchWidgetLoadResult(
            calculated_at=cached.calculated_at,
            calculation_version=context.identity.cache_key,
            config=cached_config,
            data=cached_data,
        )

    def _read_physical_result(
        self,
        context: _DashboardBatchWidgetLoadContext,
    ) -> dict[str, Any] | None:
        session = context.sessions.get(context.dataset_id)
        if session is None:
            try:
                session = DashboardDatasetQuerySession(
                    context.payload,
                    remote_budget=context.remote_budget,
                )
            except (ApiError, ValueError):
                context.session_errors[context.dataset_id] = (
                    DASHBOARD_DATA_UNAVAILABLE,
                    "Dashboard widget data could not be read from physical storage.",
                )
            if session is not None:
                context.sessions[context.dataset_id] = session

        if session is None:
            return None
        try:
            return session.read_widget(context.widget_type.value, context.config)
        except (ApiError, ValueError):
            return None

    def _store_result(
        self,
        context: _DashboardBatchWidgetLoadContext,
        result: dict[str, Any],
    ) -> DashboardBatchWidgetLoadResult:
        calculated_at = None
        if self.batch_result_repository is not None:
            calculated_at = self.batch_result_repository.save(
                cache_key=context.identity.cache_key,
                dataset_id=context.dataset_id,
                dataset_version=context.identity.dataset_version,
                widget_type=context.widget_type.value,
                config_hash=context.identity.config_hash,
                actor_scope_hash=context.identity.actor_scope_hash,
                result_payload=result,
            )
            self.batch_result_repository.db.commit()

        context.request_cache[context.request_cache_key] = {
            "calculatedAt": calculated_at,
            "calculationVersion": context.identity.cache_key,
            "result": result,
        }
        self._record_context(context, result="miss", stage="physical_query")
        return DashboardBatchWidgetLoadResult(
            calculated_at=calculated_at,
            calculation_version=context.identity.cache_key,
            config=dict(result["config"]),
            data=list(result["data"]),
        )

    def _record_context(
        self,
        context: _DashboardBatchWidgetLoadContext,
        *,
        result: str,
        stage: str,
        error_code: str | None = None,
    ) -> None:
        self._record(
            context.started_at,
            api_path=context.api_path,
            dashboard_id=context.dashboard_id,
            dataset_id=context.dataset_id,
            error_code=error_code,
            page_id=context.page_id,
            result=result,
            stage=stage,
            widget_id=context.widget_id,
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
