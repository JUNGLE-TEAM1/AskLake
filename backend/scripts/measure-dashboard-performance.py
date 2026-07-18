from __future__ import annotations

import json
from statistics import median
import time
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.services.dashboard_physical_data import DashboardRemoteScanBudget
from app.services.dashboard_runtime_service import DashboardRuntimeService


RUNS = 10
SYNTHETIC_PHYSICAL_DELAY_SECONDS = 0.02


class FixtureCatalogRepository:
    def __init__(self, db: object, payload: dict[str, object]) -> None:
        self.db = db
        self.payload = payload

    def get_dataset_payload(self, dataset_id: str) -> dict[str, object] | None:
        return self.payload if dataset_id == self.payload["id"] else None


class DelayedQuerySession:
    physical_reads = 0

    def __init__(self, _payload: object, *, remote_budget: object) -> None:
        self.remote_budget = remote_budget

    def read_widget(self, _widget_type: str, config: dict[str, object]) -> dict[str, object]:
        type(self).physical_reads += 1
        time.sleep(SYNTHETIC_PHYSICAL_DELAY_SECONDS)
        return {
            "config": {
                **config,
                "dataMode": "server_aggregated",
                "sourceConfig": dict(config),
            },
            "data": [{"category": "measured", "amount": 7}],
        }

    def close(self) -> None:
        return None


def dataset_payload() -> dict[str, object]:
    return {
        "description": "dashboard performance fixture",
        "freshness": "latest",
        "id": "dashboard-performance-dataset",
        "lastUpdated": "2026-07-18T00:00:00Z",
        "layer": "GOLD",
        "materializationRuns": [],
        "name": "dashboard-performance-dataset",
        "nextRefresh": "-",
        "owner": "dashboard-viewer",
        "permissionGrants": [{
            "actions": ["query", "view"],
            "principalId": "dashboard-viewer",
            "principalType": "user",
        }],
        "quality": "passed",
        "rag": False,
        "rows": "1 row",
        "sampleRows": [["sample", "999"]],
        "schema": [["category", "string"], ["amount", "number"]],
        "size": "1 KiB",
        "source": "fixture",
        "sourceRunId": "dashboard-performance-run-v1",
        "status": "available",
        "storageFormat": "csv",
        "storageLocation": "synthetic/dashboard-performance",
        "tags": ["performance"],
    }


def widget() -> SimpleNamespace:
    return SimpleNamespace(
        config={"aggregation": "sum", "xKey": "category", "yKey": "amount"},
        data=[],
        dataset_id="dashboard-performance-dataset",
        id="dashboard-performance-widget",
        layout={"x": 0, "y": 0, "w": 4, "h": 3},
        page_id="dashboard-performance-page",
        query_id=None,
        title="Measured widget",
        type="bar_chart",
    )


def render_widget(service: DashboardRuntimeService, *, include_data: bool) -> None:
    sessions: dict[str, object] = {}
    try:
        service._widget_to_schema(
            widget(),
            sessions,
            {},
            {},
            {},
            actor=ActorContext(name="dashboard-viewer", role="viewer"),
            api_path="/api/dashboards/dashboard-performance/published",
            dashboard_id="dashboard-performance",
            http_method="GET",
            include_data=include_data,
            remote_budget=DashboardRemoteScanBudget(max_bytes=1024 * 1024, max_objects=32),
        )
    finally:
        for session in sessions.values():
            session.close()


def measured_milliseconds(operation) -> list[float]:
    durations = []
    for _ in range(RUNS):
        started_at = time.perf_counter()
        operation()
        durations.append((time.perf_counter() - started_at) * 1000)
    return durations


def main() -> None:
    payload = dataset_payload()
    no_database = SimpleNamespace()

    def service_without_shared_cache() -> DashboardRuntimeService:
        return DashboardRuntimeService(
            SimpleNamespace(),
            FixtureCatalogRepository(no_database, payload),
        )

    with (
        patch(
            "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
            side_effect=lambda _db, dataset: dataset,
        ),
        patch("app.services.dashboard_batch_widget_loader.require_dashboard_dataset_query_access"),
        patch("app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession", DelayedQuerySession),
        patch("app.services.dashboard_batch_widget_loader.log_event"),
    ):
        DelayedQuerySession.physical_reads = 0
        shell_durations = measured_milliseconds(
            lambda: render_widget(service_without_shared_cache(), include_data=False),
        )
        shell_physical_reads = DelayedQuerySession.physical_reads

        DelayedQuerySession.physical_reads = 0
        uncached_durations = measured_milliseconds(
            lambda: render_widget(service_without_shared_cache(), include_data=True),
        )
        uncached_physical_reads = DelayedQuerySession.physical_reads

        engine = create_engine("sqlite+pysqlite:///:memory:")
        try:
            with Session(engine) as db:
                migrate_dashboard_schema(db)

            def render_with_shared_cache() -> None:
                with Session(engine) as db:
                    render_widget(
                        DashboardRuntimeService(
                            SimpleNamespace(db=db),
                            FixtureCatalogRepository(db, payload),
                        ),
                        include_data=True,
                    )

            DelayedQuerySession.physical_reads = 0
            render_with_shared_cache()
            warmup_physical_reads = DelayedQuerySession.physical_reads
            cache_hit_durations = measured_milliseconds(render_with_shared_cache)
            cache_hit_physical_reads = DelayedQuerySession.physical_reads - warmup_physical_reads
        finally:
            engine.dispose()

    print(json.dumps({
        "cacheHitMedianMs": round(median(cache_hit_durations), 3),
        "cacheHitPhysicalReads": cache_hit_physical_reads,
        "runs": RUNS,
        "shellMedianMs": round(median(shell_durations), 3),
        "shellPhysicalReads": shell_physical_reads,
        "syntheticPhysicalDelayMs": SYNTHETIC_PHYSICAL_DELAY_SECONDS * 1000,
        "uncachedWidgetMedianMs": round(median(uncached_durations), 3),
        "uncachedWidgetPhysicalReads": uncached_physical_reads,
        "warmupPhysicalReads": warmup_physical_reads,
    }, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
