from __future__ import annotations

import sys
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.auth_context import ActorContext, require_permission as real_require_permission
from app.core.errors import ApiError
from app.schemas.dashboard import DashboardCard
from app.services.demo_catalog import dataset_rows_to_widget_data
from app.services.dashboard_runtime_service import DashboardRuntimeService


class FakeDashboardRepository:
    def __init__(self, *, mixed: bool = False, published: bool = True) -> None:
        self.db = object()
        self.revision = SimpleNamespace(id="dashrev_published_1") if published else None
        self.pages = [SimpleNamespace(id="dashpage_1")]
        self.widgets = [
            SimpleNamespace(id="dashwidget_1", dataset_id="ds_live_reviews", data=[{"event_id": "snapshot"}]),
            SimpleNamespace(id="dashwidget_2", dataset_id="ds_live_reviews", data=[{"event_id": "snapshot"}]),
            SimpleNamespace(id="dashwidget_text", dataset_id=None, data=[]),
        ]
        if mixed:
            self.widgets.extend([
                SimpleNamespace(id="dashwidget_orders", dataset_id="ds_live_orders", data=[{"order_id": "snapshot"}]),
                SimpleNamespace(id="dashwidget_batch", dataset_id="ds_batch_parquet", data=[{"id": "snapshot"}]),
            ])

    def get_published_revision(self, _dashboard_id: str):
        return self.revision

    def list_pages(self, _revision_id: str):
        return self.pages

    def list_widgets_by_page_ids(self, _page_ids: list[str]):
        return {self.pages[0].id: self.widgets}


class FakeCatalogRepository:
    def __init__(self, payload: dict | dict[str, dict] | None) -> None:
        if payload is None:
            self.payloads = {}
        elif "id" in payload:
            self.payloads = {str(payload["id"]): payload}
        else:
            self.payloads = payload
        self.calls: list[str] = []

    def get_dataset_payload(self, dataset_id: str):
        self.calls.append(dataset_id)
        return self.payloads.get(dataset_id)


def dashboard_card() -> DashboardCard:
    return DashboardCard(
        id="dash_live",
        name="Live reviews",
        owner="dashboard-owner",
        meta="2개 위젯",
        status="published",
        tags="Kafka",
        updated="방금 전",
        permission_grants=[{
            "actions": ["view"],
            "principalId": "dashboard-viewer",
            "principalType": "user",
        }],
    )


def dataset_payload(
    *,
    dataset_id: str = "ds_live_reviews",
    dashboard_sync_interval_minutes: int | None = None,
    execution_mode: str | None = "continuous",
    query_allowed: bool = True,
    source_run_id: str = "continuous:job:batch:2",
) -> dict:
    grants = [{
        "actions": ["query"],
        "principalId": "dashboard-viewer",
        "principalType": "user",
    }] if query_allowed else []
    payload = {
        "description": "Latest valid Kafka rows",
        "downstream": ["dashboard"],
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-13T12:00:00Z",
        "layer": "BRONZE",
        "name": dataset_id.removeprefix("ds_"),
        "nextRefresh": "continuous",
        "owner": "dataset-owner",
        "permissionGrants": grants,
        "quality": "pass",
        "rag": False,
        "rows": "2 rows",
        "sampleRows": [["evt-2", "5"], ["evt-1", "3"]],
        "schema": [["event_id", "string"], ["rating", "integer"]],
        "size": "1KB",
        "source": "reviews_continuous",
        "sourceRunId": source_run_id,
        "status": "available",
        "tags": ["kafka"],
        "upstream": ["reviews.raw"],
    }
    if execution_mode is not None:
        payload["sourceExecutionMode"] = execution_mode
        payload["sourceKind"] = "kafka" if execution_mode == "continuous" else "etl"
    if dashboard_sync_interval_minutes is not None:
        payload["dashboardSyncIntervalMinutes"] = dashboard_sync_interval_minutes
    return payload


def service_context():
    return (
        patch("app.services.dashboard_runtime_service.get_dashboard_card", return_value=dashboard_card()),
        patch("app.services.dashboard_runtime_service.dashboard_with_persisted_permission_grants", side_effect=lambda _db, value: value),
        patch("app.services.dashboard_runtime_service.dataset_with_persisted_permission_grants", side_effect=lambda _db, value: value),
        patch("app.services.dashboard_runtime_service.require_governed_access"),
    )


def verify_success() -> None:
    repository = FakeDashboardRepository(mixed=True)
    catalog_repository = FakeCatalogRepository({
        "ds_live_reviews": dataset_payload(dashboard_sync_interval_minutes=60),
        "ds_live_orders": dataset_payload(
            dataset_id="ds_live_orders",
            dashboard_sync_interval_minutes=3,
            source_run_id="continuous:orders:batch:7",
        ),
        "ds_batch_parquet": dataset_payload(
            dataset_id="ds_batch_parquet",
            execution_mode="snapshot",
            source_run_id="run-batch-1",
        ),
    })
    service = DashboardRuntimeService(repository, catalog_repository)
    actor = ActorContext(name="dashboard-viewer", role="viewer")
    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3], patch(
        "app.services.dashboard_runtime_service.require_permission",
        wraps=real_require_permission,
    ) as permission_check:
        response = service.get_published_data("dash_live", actor)

    payload = response.model_dump(by_alias=True, mode="json")
    assert payload["dashboardId"] == "dash_live"
    assert payload["revisionId"] == "dashrev_published_1"
    assert payload["refreshedAt"]
    assert payload["refreshScope"] == "all"
    assert payload["autoRefreshIntervalMinutes"] == 3
    assert [item["widgetId"] for item in payload["widgets"]] == [
        "dashwidget_1",
        "dashwidget_2",
        "dashwidget_orders",
        "dashwidget_batch",
    ]
    assert payload["widgets"][0]["data"] == [{"event_id": "evt-2", "rating": 5.0}, {"event_id": "evt-1", "rating": 3.0}]
    assert payload["widgets"][0]["datasetUpdatedAt"] == "2026-07-13T12:00:00Z"
    assert payload["widgets"][0]["sourceRunId"] == "continuous:job:batch:2"
    assert sum(call.args[1] == "query" for call in permission_check.call_args_list) == 3
    assert catalog_repository.calls.count("ds_live_reviews") == 1
    assert repository.widgets[0].data == [{"event_id": "snapshot"}], "Refresh must not mutate the published snapshot."

    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3], patch(
        "app.services.dashboard_runtime_service.require_permission",
        wraps=real_require_permission,
    ) as permission_check:
        response = service.get_published_data("dash_live", actor, scope="continuous_kafka")
    payload = response.model_dump(by_alias=True, mode="json")
    assert payload["refreshScope"] == "continuous_kafka"
    assert payload["autoRefreshIntervalMinutes"] == 3
    assert [item["widgetId"] for item in payload["widgets"]] == [
        "dashwidget_1",
        "dashwidget_2",
        "dashwidget_orders",
    ]
    assert all(item["datasetId"] != "ds_batch_parquet" for item in payload["widgets"])
    assert sum(call.args[1] == "query" for call in permission_check.call_args_list) == 2

    with patch(
        "app.services.demo_catalog._storage_rows_to_widget_data",
        return_value=[{"event_id": "physical-first-row"}],
    ):
        bounded_sample = dataset_rows_to_widget_data(dataset_payload(), prefer_storage=False)
    assert bounded_sample[0]["event_id"] == "evt-2", "Dashboard refresh must prefer the latest Catalog sample over physical first rows."


def verify_legacy_interval_fallback_and_clamp() -> None:
    actor = ActorContext(name="dashboard-viewer", role="viewer")
    contexts = service_context()
    legacy_payload = dataset_payload(execution_mode=None)
    with contexts[0], contexts[1], contexts[2], contexts[3]:
        response = DashboardRuntimeService(
            FakeDashboardRepository(),
            FakeCatalogRepository(legacy_payload),
        ).get_published_data("dash_live", actor, scope="continuous_kafka")
    payload = response.model_dump(by_alias=True, mode="json")
    assert payload["autoRefreshIntervalMinutes"] == 5
    assert len(payload["widgets"]) == 2

    too_large = dataset_payload(dashboard_sync_interval_minutes=120)
    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3]:
        response = DashboardRuntimeService(
            FakeDashboardRepository(),
            FakeCatalogRepository(too_large),
        ).get_published_data("dash_live", actor, scope="continuous_kafka")
    assert response.auto_refresh_interval_minutes == 60

    batch_only = dataset_payload(execution_mode="snapshot", source_run_id="run-batch-1")
    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3]:
        response = DashboardRuntimeService(
            FakeDashboardRepository(),
            FakeCatalogRepository(batch_only),
        ).get_published_data("dash_live", actor, scope="continuous_kafka")
    payload = response.model_dump(by_alias=True, mode="json")
    assert payload["widgets"] == []
    assert payload["autoRefreshIntervalMinutes"] is None


def verify_failures() -> None:
    actor = ActorContext(name="dashboard-viewer", role="viewer")
    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3]:
        try:
            DashboardRuntimeService(
                FakeDashboardRepository(published=False),
                FakeCatalogRepository(dataset_payload()),
            ).get_published_data("dash_live", actor)
        except ApiError as error:
            assert error.status_code == 404
        else:
            raise AssertionError("A dashboard without a published revision must return 404.")

    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3]:
        try:
            DashboardRuntimeService(
                FakeDashboardRepository(),
                FakeCatalogRepository(None),
            ).get_published_data("dash_live", actor)
        except ApiError as error:
            assert error.status_code == 404
            assert error.details["datasetId"] == "ds_live_reviews"
        else:
            raise AssertionError("A missing published widget dataset must return 404.")

    contexts = service_context()
    with contexts[0], contexts[1], contexts[2], contexts[3], patch(
        "app.services.catalog_service.safe_record_audit_event",
    ) as audit_event:
        try:
            DashboardRuntimeService(
                FakeDashboardRepository(),
                FakeCatalogRepository(dataset_payload(query_allowed=False)),
            ).get_published_data("dash_live", actor)
        except ApiError as error:
            assert error.status_code == 403
        else:
            raise AssertionError("Dataset query permission is required for published refresh data.")
        assert audit_event.call_args.kwargs["action"] == "dataset.query.forbidden"
        assert audit_event.call_args.kwargs["target_id"] == "ds_live_reviews"


if __name__ == "__main__":
    verify_success()
    verify_legacy_interval_fallback_and_clamp()
    verify_failures()
    print("verify-dashboard-published-data-contract: ok")
