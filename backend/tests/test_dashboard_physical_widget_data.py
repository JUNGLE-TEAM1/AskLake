import os
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch

import duckdb
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.core.observability import metrics_snapshot, reset_metrics_for_test
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    DashboardRuntimeWidgetType,
    DonutChartWidgetConfig,
    LineChartWidgetConfig,
)
from app.schemas.trino import TrinoClientPage
from app.services import dashboard_physical_data
from app.services.dashboard_physical_data import (
    DASHBOARD_VALUE_ALIAS,
    DashboardDatasetQuerySession,
    DashboardRemoteScanBudget,
    canonical_materialization_mode,
    configure_dashboard_duckdb_resources,
    dataset_storage_segments,
    execute_dashboard_query,
    preflight_dashboard_s3_segments,
    dashboard_widget_supports_incremental_merge,
    merge_dashboard_aggregate_states,
)
from app.services.dashboard_runtime_service import (
    DASHBOARD_DATA_FORBIDDEN,
    DASHBOARD_DATA_UNAVAILABLE,
    DashboardRuntimeService,
    MAX_EXPLICIT_WIDGET_ROWS,
)


def catalog_dataset_payload(
    *,
    dataset_id: str = "catalog-dataset",
    owner: str = "dataset-owner",
    sample_rows: list[list[str]] | None = None,
    storage_format: str | None = None,
    storage_location: str | None = None,
) -> dict[str, object]:
    return {
        "description": "test dataset",
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-12T00:00:00Z",
        "layer": "GOLD",
        "materializationRuns": [],
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": owner,
        "permissionGrants": [{
            "actions": ["query", "view"],
            "principalId": "dashboard-viewer",
            "principalType": "user",
        }],
        "quality": "passed",
        "rag": False,
        "rows": "2 rows",
        "sampleRows": sample_rows or [["sample-only", "999"]],
        "schema": [["category", "string"], ["amount", "number"]],
        "size": "1 KiB",
        "source": "test",
        "status": "available",
        "storageFormat": storage_format,
        "storageLocation": storage_location,
        "tags": ["test"],
    }


def runtime_widget(
    *,
    dataset_id: str | None = "catalog-dataset",
    query_id: str | None = None,
    data: list[dict[str, object]] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        config={"aggregation": "sum", "xKey": "category", "yKey": "amount"},
        data=data or [{"category": "stored", "amount": 999}],
        dataset_id=dataset_id,
        id="widget-1",
        layout={"x": 0, "y": 0, "w": 4, "h": 3},
        page_id="page-1",
        query_id=query_id,
        title="Sales",
        type="bar_chart",
    )


def render_runtime_widget(
    service: DashboardRuntimeService,
    widget: SimpleNamespace,
    *,
    include_data: bool = True,
    sessions: dict[str, object] | None = None,
):
    return service._widget_to_schema(
        widget,
        sessions if sessions is not None else {},
        {},
        {},
        {},
        actor=ActorContext(name="dashboard-viewer", role="viewer"),
        remote_budget=DashboardRemoteScanBudget(max_bytes=1024 * 1024, max_objects=32),
        api_path="/api/dashboards/dashboard-a/published",
        dashboard_id="dashboard-a",
        http_method="GET",
        include_data=include_data,
    )


class FakeDashboardS3Client:
    def __init__(self, objects_by_prefix: dict[str, list[dict[str, object]]]) -> None:
        self.objects_by_prefix = objects_by_prefix
        self.calls: list[dict[str, object]] = []

    def list_objects_v2(self, **request: object) -> dict[str, object]:
        self.calls.append(dict(request))
        return {
            "Contents": self.objects_by_prefix.get(str(request.get("Prefix") or ""), []),
            "IsTruncated": False,
        }


class FakeDashboardTrinoClient:
    def __init__(self, *, include_run_id: bool = True) -> None:
        self.queries: list[str] = []
        self.include_run_id = include_run_id

    def submit(self, query: str, **_kwargs) -> TrinoClientPage:
        self.queries.append(query)
        if query.startswith("DESCRIBE"):
            rows = [
                ["category", "varchar"],
                ["amount", "bigint"],
            ]
            if self.include_run_id:
                rows.append(["_asklake_run_id", "varchar"])
            return TrinoClientPage(
                columns=["Column", "Type"],
                rows=rows,
                queryId="describe",
            )
        if "__asklake_state_count" in query:
            return TrinoClientPage(
                columns=[
                    "category",
                    "__asklake_state_count",
                    "__asklake_state_sum",
                    "__asklake_state_min",
                    "__asklake_state_max",
                ],
                rows=[["phones", 2, 15.0, 5.0, 10.0]],
                queryId="aggregate-state",
            )
        return TrinoClientPage(
            columns=["category", "amount"],
            rows=[["phones", 15.0]],
            queryId="widget",
        )

    def fetch(self, _next_uri: str, **_kwargs) -> TrinoClientPage:
        raise AssertionError("fixture query should fit in one Trino page")


class CaseMismatchedIcebergTrinoClient(FakeDashboardTrinoClient):
    """Catalog uses title case while the materialized Iceberg fields are lowercase."""

    def submit(self, query: str, **_kwargs) -> TrinoClientPage:
        self.queries.append(query)
        if query.startswith("DESCRIBE"):
            return TrinoClientPage(
                columns=["Column", "Type"],
                rows=[
                    ["topic", "varchar"],
                    ["partition", "bigint"],
                    ["leader", "bigint"],
                    ["_asklake_run_id", "varchar"],
                ],
                queryId="describe",
            )
        if "COUNT(*)" in query and "GROUP BY" not in query:
            return TrinoClientPage(
                columns=[DASHBOARD_VALUE_ALIAS], rows=[[10_000]], queryId="metric",
            )
        if "GROUP BY" in query:
            return TrinoClientPage(
                columns=["Topic", DASHBOARD_VALUE_ALIAS],
                rows=[["reviews.raw", 10_000]],
                queryId="bar-chart",
            )
        return TrinoClientPage(
            columns=["Topic", "Partition", "Leader"],
            rows=[["reviews.raw", 0, 0]],
            queryId="table",
        )


class EndlessDashboardTrinoClient:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    def submit(self, _query: str, **_kwargs) -> TrinoClientPage:
        return TrinoClientPage(nextUri="http://trino:8080/v1/statement/query/1", queryId="query-1")

    def fetch(self, next_uri: str, **_kwargs) -> TrinoClientPage:
        time.sleep(0.02)
        return TrinoClientPage(nextUri=next_uri, queryId="query-1")

    def cancel(self, next_uri: str, **_kwargs) -> None:
        self.cancelled.append(next_uri)


class InterruptibleDuckDbConnection:
    def __init__(self) -> None:
        self.interrupted = False
        self.finished = Event()

    def execute(self, _query: str) -> None:
        self.finished.wait(1)
        raise duckdb.Error("Interrupted" if self.interrupted else "Timed out")

    def interrupt(self) -> None:
        self.interrupted = True
        self.finished.set()


class FakeCatalogRepository:
    def __init__(self, payloads=None):
        self.db = SimpleNamespace()
        self.payloads = (
            {"catalog-dataset": {"id": "catalog-dataset"}}
            if payloads is None
            else payloads
        )

    def get_dataset_payload(self, dataset_id: str):
        return self.payloads.get(dataset_id)


class DashboardPhysicalWidgetDataTests(unittest.TestCase):
    @staticmethod
    def iceberg_dataset() -> dict[str, object]:
        dataset = catalog_dataset_payload(
            storage_format="iceberg",
            storage_location="s3://warehouse/asklake/catalog-dataset",
        )
        dataset.update({
            "queryEngineStatus": "available",
            "queryEngineTable": {
                "catalog": "iceberg",
                "schema": "asklake",
                "table": "catalog_dataset",
                "format": "iceberg",
            },
        })
        return dataset

    def test_iceberg_widget_uses_trino_instead_of_scanning_warehouse_files(self) -> None:
        dataset = self.iceberg_dataset()
        client = FakeDashboardTrinoClient()
        session = DashboardDatasetQuerySession(
            dataset,
            trino_client=client,  # type: ignore[arg-type]
        )
        try:
            result = session.read_widget("bar_chart", {
                "aggregation": "sum",
                "xKey": "category",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertEqual(result["data"], [{"category": "phones", "amount": 15.0}])
        self.assertEqual(len(client.queries), 2)
        self.assertIn('FROM "iceberg"."asklake"."catalog_dataset"', client.queries[1])
        self.assertIn('GROUP BY "category"', client.queries[1])
        self.assertNotIn("GROUP BY ALL", client.queries[1])
        self.assertNotIn("_asklake_run_id", client.queries[1])

    def test_iceberg_case_mismatched_catalog_columns_use_physical_sql_names(self) -> None:
        dataset = self.iceberg_dataset()
        dataset["schema"] = [["Topic", "string"], ["Partition", "number"], ["Leader", "number"]]
        client = CaseMismatchedIcebergTrinoClient()
        session = DashboardDatasetQuerySession(dataset, trino_client=client)  # type: ignore[arg-type]
        try:
            metric = session.read_widget("metric", {"aggregation": "count"})
            chart = session.read_widget("bar_chart", {
                "aggregation": "count", "xKey": "Topic", "yKey": "Partition",
            })
            table = session.read_widget("table", {
                "columns": ["Topic", "Partition", "Leader"], "sortKey": "Partition",
            })
        finally:
            session.close()

        self.assertEqual(metric["data"], [{DASHBOARD_VALUE_ALIAS: 10_000}])
        self.assertEqual(chart["data"], [{"Topic": "reviews.raw", DASHBOARD_VALUE_ALIAS: 10_000}])
        self.assertEqual(table["data"], [{"Topic": "reviews.raw", "Partition": 0, "Leader": 0}])
        self.assertEqual(session.columns, {"Topic", "Partition", "Leader"})
        self.assertIn('"topic" AS "Topic"', client.queries[2])
        self.assertIn('GROUP BY "topic"', client.queries[2])
        self.assertIn('"partition" AS "Partition"', client.queries[3])
        self.assertIn('ORDER BY "partition" ASC', client.queries[3])

    def test_iceberg_case_insensitive_physical_collision_is_rejected(self) -> None:
        dataset = self.iceberg_dataset()
        dataset["schema"] = [["Topic", "string"]]

        class CollisionClient(CaseMismatchedIcebergTrinoClient):
            def submit(self, query: str, **_kwargs) -> TrinoClientPage:
                self.queries.append(query)
                return TrinoClientPage(
                    columns=["Column", "Type"],
                    rows=[["Topic", "varchar"], ["topic", "varchar"]],
                    queryId="describe",
                )

        with self.assertRaisesRegex(ApiError, "physical data could not be read") as raised:
            DashboardDatasetQuerySession(dataset, trino_client=CollisionClient())  # type: ignore[arg-type]

        self.assertIn("ambiguous case-insensitive column", str(raised.exception.details))

    def test_iceberg_aggregate_state_uses_trino_with_explicit_group_by(self) -> None:
        client = FakeDashboardTrinoClient()
        session = DashboardDatasetQuerySession(
            self.iceberg_dataset(),
            trino_client=client,  # type: ignore[arg-type]
        )
        try:
            state = session.read_aggregate_state("bar_chart", {
                "aggregation": "sum",
                "xKey": "category",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertIsNotNone(state)
        self.assertEqual(state["rows"][0]["__asklake_state_sum"], 15.0)
        self.assertEqual(len(client.queries), 2)
        self.assertIn('FROM "iceberg"."asklake"."catalog_dataset"', client.queries[1])
        self.assertIn('GROUP BY "category"', client.queries[1])
        self.assertNotIn("GROUP BY ALL", client.queries[1])
        self.assertNotIn("FOR VERSION AS OF", client.queries[1])
        self.assertNotIn("_asklake_run_id", client.queries[1])

    def test_iceberg_full_aggregate_is_pinned_to_the_catalog_snapshot(self) -> None:
        dataset = self.iceberg_dataset()
        dataset["icebergSnapshotId"] = "000123"
        client = FakeDashboardTrinoClient()
        session = DashboardDatasetQuerySession(
            dataset,
            trino_client=client,  # type: ignore[arg-type]
        )
        try:
            state = session.read_aggregate_state("bar_chart", {
                "aggregation": "sum",
                "xKey": "category",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertIsNotNone(state)
        self.assertEqual(
            client.queries[0],
            'DESCRIBE "iceberg"."asklake"."catalog_dataset"',
        )
        self.assertIn(
            'FROM "iceberg"."asklake"."catalog_dataset" FOR VERSION AS OF 123',
            client.queries[1],
        )

    def test_iceberg_rejects_invalid_catalog_snapshot_instead_of_reading_current(self) -> None:
        dataset = self.iceberg_dataset()
        dataset["icebergSnapshotId"] = "123 OR 1=1"
        client = FakeDashboardTrinoClient()

        with self.assertRaises(ApiError):
            DashboardDatasetQuerySession(
                dataset,
                trino_client=client,  # type: ignore[arg-type]
            )

        self.assertEqual(client.queries, [])

    def test_iceberg_revision_delta_filters_only_the_published_run_id(self) -> None:
        dataset = self.iceberg_dataset()
        dataset["icebergSnapshotId"] = "456"
        client = FakeDashboardTrinoClient()
        session = DashboardDatasetQuerySession(
            dataset,
            trino_client=client,  # type: ignore[arg-type]
            iceberg_run_id="continuous:job:batch:x'y",
        )
        try:
            state = session.read_aggregate_state("bar_chart", {
                "aggregation": "sum",
                "xKey": "category",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertIsNotNone(state)
        self.assertTrue(session.revision_delta_available)
        self.assertIn(
            'FROM "iceberg"."asklake"."catalog_dataset" FOR VERSION AS OF 456',
            client.queries[1],
        )
        self.assertIn(
            'WHERE "_asklake_run_id" = \'continuous:job:batch:x\'\'y\'',
            client.queries[1],
        )

    def test_iceberg_revision_delta_falls_back_when_run_id_column_is_missing(self) -> None:
        client = FakeDashboardTrinoClient(include_run_id=False)
        session = DashboardDatasetQuerySession(
            self.iceberg_dataset(),
            trino_client=client,  # type: ignore[arg-type]
            iceberg_run_id="continuous:job:batch:2",
        )
        try:
            state = session.read_aggregate_state("bar_chart", {
                "aggregation": "sum",
                "xKey": "category",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertFalse(session.revision_delta_available)
        self.assertIsNone(state)
        self.assertEqual(len(client.queries), 1)

    def test_chart_aggregation_reads_all_materializations_instead_of_sample_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "run-1"
            second = root / "run-2"
            first.mkdir()
            second.mkdir()
            (first / "part.csv").write_text(
                "category,amount\nphones,10\naccessories,7\n",
                encoding="utf-8",
            )
            (second / "part.csv").write_text(
                "category,amount\nphones,5\n",
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[
                    SimpleNamespace(materialization_mode="delta", status="success", storage_format="csv", storage_location=str(first)),
                    SimpleNamespace(materialization_mode="delta", status="success", storage_format="csv", storage_location=str(second)),
                ],
                name="dashboard_physical",
                sample_rows=[["sample-only", "999"]],
                storage_format="csv",
                storage_location=str(second),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                result = session.read_widget("bar_chart", {
                    "aggregation": "sum",
                    "xKey": "category",
                    "yKey": "amount",
                })
            finally:
                session.close()

        self.assertEqual(
            result["data"],
            [
                {"category": "phones", "amount": 15.0},
                {"category": "accessories", "amount": 7.0},
            ],
        )
        self.assertEqual(result["config"]["dataMode"], "server_aggregated")
        self.assertEqual(result["config"]["sourceConfig"]["aggregation"], "sum")

    def test_count_aggregation_preserves_edit_config_and_returns_exact_counts(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text(
                "category\nphones\nphones\nphones\naccessories\naccessories\n",
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_counts",
                sample_rows=[["sample-only"]],
                storage_format="csv",
                storage_location=str(root),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                result = session.read_widget("donut_chart", {
                    "aggregation": "count",
                    "labelKey": "category",
                    "valueKey": "",
                })
            finally:
                session.close()

        self.assertEqual(result["config"]["aggregation"], "sum")
        self.assertEqual(result["config"]["valueKey"], DASHBOARD_VALUE_ALIAS)
        self.assertEqual(result["config"]["sourceConfig"]["aggregation"], "count")
        self.assertEqual(
            result["data"],
            [
                {"category": "phones", DASHBOARD_VALUE_ALIAS: 3},
                {"category": "accessories", DASHBOARD_VALUE_ALIAS: 2},
            ],
        )

    def test_mergeable_aggregations_are_incrementally_merged(self) -> None:
        self.assertFalse(dashboard_widget_supports_incremental_merge(
            "table",
            {"columns": ["amount"]},
        ))
        for aggregation in ("count", "sum", "avg", "ratio", "min", "max"):
            with self.subTest(aggregation=aggregation):
                self.assertTrue(dashboard_widget_supports_incremental_merge(
                    "metric",
                    {"aggregation": aggregation, "valueKey": "amount"},
                ))
        self.assertFalse(dashboard_widget_supports_incremental_merge(
            "metric",
            {"aggregation": "distinct", "valueKey": "order_id"},
        ))

    def test_rolling_day_state_evicts_expired_buckets_without_full_scan(self) -> None:
        current = {
            "version": 1,
            "widgetType": "line_chart",
            "aggregation": "ratio",
            "dimensionKeys": ["event_date"],
            "valueConfigKey": "yKey",
            "valueAlias": "conversion_rate_pct",
            "windowDays": 30,
            "windowDimensionKey": "event_date",
            "rows": [{
                "event_date": "2026-06-01T00:00:00",
                "__asklake_state_count": 100,
                "__asklake_state_sum": 5,
            }],
        }
        delta = {
            **current,
            "rows": [{
                "event_date": "2026-07-01T00:00:00",
                "__asklake_state_count": 100,
                "__asklake_state_sum": 7,
            }],
        }

        merged = merge_dashboard_aggregate_states(current, delta)

        self.assertIsNotNone(merged)
        self.assertEqual(
            [row["event_date"] for row in merged["rows"]],
            ["2026-07-01T00:00:00"],
        )

    def test_table_preview_is_sorted_and_capped_before_browser_response(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            rows = "\n".join(f"{index},value-{index}" for index in range(1, 506))
            (root / "part.csv").write_text(f"id,value\n{rows}\n", encoding="utf-8")
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_table",
                sample_rows=[["sample-only", "sample-only"]],
                storage_format="csv",
                storage_location=str(root),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                result = session.read_widget("table", {
                    "columns": ["id", "value"],
                    "limit": 10_000,
                    "sortDirection": "desc",
                    "sortKey": "id",
                })
            finally:
                session.close()

        self.assertEqual(len(result["data"]), 500)
        self.assertEqual(result["data"][0], {"id": 505, "value": "value-505"})
        self.assertEqual(result["data"][-1], {"id": 6, "value": "value-6"})
        self.assertEqual(result["config"]["dataMode"], "server_preview")

    def test_time_series_supports_minute_and_hour_buckets_and_keeps_latest_window(self) -> None:
        line_config = LineChartWidgetConfig.model_validate({
            "aggregation": "sum",
            "color": {"colors": ["#2563eb"]},
            "dateUnit": "minute",
            "xKey": "event_time",
            "yKey": "amount",
        })
        area_config = AreaChartWidgetConfig.model_validate({
            "aggregation": "sum",
            "color": {"colors": ["#2563eb"]},
            "dateUnit": "hour",
            "xKey": "event_time",
            "yKey": "amount",
        })
        self.assertEqual(line_config.date_unit, "minute")
        self.assertEqual(area_config.date_unit, "hour")

        with TemporaryDirectory() as directory:
            root = Path(directory)
            start = datetime(2026, 7, 19)
            rows = "\n".join(
                f"{(start + timedelta(minutes=index)).isoformat()},1"
                for index in range(505)
            )
            (root / "part.csv").write_text(
                f"event_time,amount\nnot-a-timestamp,1\n{rows}\n",
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_time_series",
                sample_rows=[],
                storage_format="csv",
                storage_location=str(root),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                minute_result = session.read_widget(
                    "line_chart",
                    line_config.model_dump(by_alias=True, mode="json"),
                )
                hour_result = session.read_widget(
                    "area_chart",
                    area_config.model_dump(by_alias=True, mode="json"),
                )
            finally:
                session.close()

        self.assertEqual(len(minute_result["data"]), 500)
        self.assertEqual(minute_result["data"][0]["event_time"], "2026-07-19T00:05:00")
        self.assertEqual(minute_result["data"][-1]["event_time"], "2026-07-19T08:24:00")
        self.assertTrue(all(row["event_time"] is not None for row in minute_result["data"]))
        self.assertEqual(len(hour_result["data"]), 9)
        self.assertEqual(hour_result["data"][0]["amount"], 60.0)
        self.assertEqual(hour_result["data"][-1]["amount"], 25.0)

    def test_catalog_widgets_ignore_client_rows_but_bounded_query_snapshots_remain_supported(self) -> None:
        service = DashboardRuntimeService(SimpleNamespace(), FakeCatalogRepository())
        client_rows = [{"value": index} for index in range(MAX_EXPLICIT_WIDGET_ROWS + 25)]

        self.assertEqual(service._resolve_widget_data(client_rows, "catalog-dataset"), [])
        self.assertEqual(
            len(service._resolve_widget_data(client_rows, "sql-result-run-1")),
            MAX_EXPLICIT_WIDGET_ROWS,
        )

    def test_dashboard_session_never_falls_back_to_catalog_sample_rows(self) -> None:
        dataset = SimpleNamespace(
            id="catalog-dataset",
            materialization_runs=[],
            name="sample_only_dashboard",
            sample_rows=[["sample-only", 999]],
            storage_format=None,
            storage_location=None,
        )

        with self.assertRaises(ApiError) as context:
            DashboardDatasetQuerySession(dataset)

        self.assertEqual(context.exception.status_code, 503)
        self.assertIn("physical", context.exception.message.lower())

    def test_runtime_widget_replaces_stored_sample_data_with_physical_aggregation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text(
                "category,amount\nphones,4\nphones,6\naccessories,3\n",
                encoding="utf-8",
            )
            payload = catalog_dataset_payload(
                storage_format="csv",
                storage_location=str(root),
            )
            payload["name"] = "runtime_physical"
            service = DashboardRuntimeService(
                SimpleNamespace(),
                FakeCatalogRepository({"catalog-dataset": payload}),
            )
            widget = runtime_widget(data=[{"category": "sample-only", "amount": 999}])
            sessions = {}
            try:
                with (
                    patch(
                        "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                        side_effect=lambda _db, dataset: dataset,
                    ),
                    patch(
                        "app.services.dashboard_batch_widget_loader.require_dashboard_dataset_query_access"
                    ),
                ):
                    response = render_runtime_widget(service, widget, sessions=sessions)
            finally:
                for session in sessions.values():
                    session.close()

        self.assertEqual(
            response.data,
            [
                {"category": "phones", "amount": 10.0},
                {"category": "accessories", "amount": 3.0},
            ],
        )
        self.assertEqual(response.config.data_mode, "server_aggregated")

    def test_runtime_shell_returns_widget_metadata_without_opening_storage(self) -> None:
        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="must/not/be-opened",
        )
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository({"catalog-dataset": payload}),
        )

        with patch(
            "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession"
        ) as query_session:
            response = render_runtime_widget(
                service,
                runtime_widget(),
                include_data=False,
            )

        query_session.assert_not_called()
        self.assertEqual(response.data, [])
        self.assertEqual(response.data_status, "pending")
        self.assertEqual(response.dataset_id, "catalog-dataset")

    def test_batch_widget_result_is_reused_after_permission_is_rechecked(self) -> None:
        reset_metrics_for_test()
        engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(engine) as db:
            migrate_dashboard_schema(db)

        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="cache-fixture",
        )
        payload["sourceRunId"] = "run-1"
        physical_reads: list[str] = []
        permission_checks: list[str] = []
        widget_data_events: list[dict[str, object]] = []

        class FakeQuerySession:
            def __init__(self, _payload, *, remote_budget):
                self.remote_budget = remote_budget

            def read_widget(self, _widget_type, config):
                physical_reads.append("read")
                return {
                    "config": {
                        **config,
                        "dataMode": "server_aggregated",
                        "sourceConfig": dict(config),
                    },
                    "data": [{"category": "cached", "amount": 7}],
                }

            def close(self):
                return None

        responses = []
        with patch(
            "app.services.dashboard_batch_widget_loader.log_event",
            side_effect=lambda _logger, event, **fields: widget_data_events.append({"event": event, **fields}),
        ), patch(
            "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
            side_effect=lambda _db, dataset: dataset,
        ), patch(
            "app.services.dashboard_batch_widget_loader.require_dashboard_dataset_query_access",
            side_effect=lambda *_args, **_kwargs: permission_checks.append("checked"),
        ), patch(
            "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession",
            FakeQuerySession,
        ):
            for _ in range(2):
                with Session(engine) as db:
                    catalog_repository = FakeCatalogRepository({"catalog-dataset": payload})
                    catalog_repository.db = db
                    service = DashboardRuntimeService(
                        SimpleNamespace(db=db),
                        catalog_repository,
                    )
                    sessions = {}
                    try:
                        responses.append(render_runtime_widget(service, runtime_widget(), sessions=sessions))
                    finally:
                        for session in sessions.values():
                            session.close()

        with Session(engine) as db:
            catalog_repository = FakeCatalogRepository({"catalog-dataset": payload})
            catalog_repository.db = db
            service = DashboardRuntimeService(SimpleNamespace(db=db), catalog_repository)
            with patch(
                "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ), patch(
                "app.services.dashboard_batch_widget_loader.require_dashboard_dataset_query_access",
                side_effect=ApiError(ErrorCode.FORBIDDEN, "denied", 403),
            ), patch(
                "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession"
            ) as query_session:
                denied_response = render_runtime_widget(service, runtime_widget())
            query_session.assert_not_called()

        engine.dispose()
        self.assertEqual(physical_reads, ["read"])
        self.assertEqual(permission_checks, ["checked", "checked"])
        self.assertEqual(responses[0].data, responses[1].data)
        self.assertEqual(responses[0].calculation_version, responses[1].calculation_version)
        self.assertEqual(denied_response.data, [])
        self.assertEqual(denied_response.config.error, DASHBOARD_DATA_FORBIDDEN)
        metrics = metrics_snapshot()
        self.assertEqual(metrics["dashboard_widget_data_total{result=miss,stage=physical_query}"], 1)
        self.assertEqual(metrics["dashboard_widget_data_total{result=hit,stage=postgres_cache}"], 1)
        self.assertEqual(widget_data_events[0]["dashboardId"], "dashboard-a")
        self.assertEqual(widget_data_events[0]["stage"], "physical_query")
        self.assertNotIn("config", widget_data_events[0])
        self.assertNotIn("data", widget_data_events[0])

    def test_batch_cache_key_changes_with_dataset_config_and_actor_scope(self) -> None:
        from app.services.dashboard_batch_cache import dashboard_batch_cache_identity

        base_payload = catalog_dataset_payload()
        base_payload["sourceRunId"] = "run-1"
        base_config = {"aggregation": "sum", "xKey": "category", "yKey": "amount"}
        base_actor = ActorContext(name="analyst-a", role="viewer", groups=("finance",))
        base = dashboard_batch_cache_identity(
            base_payload,
            DashboardRuntimeWidgetType.BAR_CHART,
            base_config,
            base_actor,
        )

        newer_payload = {**base_payload, "sourceRunId": "run-2"}
        changed_dataset = dashboard_batch_cache_identity(
            newer_payload,
            DashboardRuntimeWidgetType.BAR_CHART,
            base_config,
            base_actor,
        )
        changed_config = dashboard_batch_cache_identity(
            base_payload,
            DashboardRuntimeWidgetType.BAR_CHART,
            {**base_config, "aggregation": "avg"},
            base_actor,
        )
        changed_filter = dashboard_batch_cache_identity(
            base_payload,
            DashboardRuntimeWidgetType.BAR_CHART,
            {
                **base_config,
                "filters": [{
                    "id": "category-filter",
                    "column": "category",
                    "operator": "eq",
                    "value": "Wearable Technology",
                }],
            },
            base_actor,
        )
        changed_actor = dashboard_batch_cache_identity(
            base_payload,
            DashboardRuntimeWidgetType.BAR_CHART,
            base_config,
            ActorContext(name="analyst-b", role="viewer", groups=("finance",)),
        )

        self.assertNotEqual(base.cache_key, changed_dataset.cache_key)
        self.assertNotEqual(base.cache_key, changed_config.cache_key)
        self.assertNotEqual(base.cache_key, changed_filter.cache_key)
        self.assertNotEqual(base.cache_key, changed_actor.cache_key)

    def test_runtime_widget_returns_a_stable_error_when_physical_storage_is_unavailable(self) -> None:
        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="missing/dashboard/data",
        )
        payload["name"] = "runtime_missing"
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository({"catalog-dataset": payload}),
        )
        widget = runtime_widget(data=[{"category": "sample-only", "amount": 999}])

        with (
            patch(
                "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.dashboard_batch_widget_loader.require_dashboard_dataset_query_access"
            ),
        ):
            response = render_runtime_widget(service, widget)

        self.assertEqual(response.data, [])
        self.assertEqual(response.config.error, "DASHBOARD_DATA_UNAVAILABLE")

    def test_runtime_checks_dataset_governance_and_query_permission_before_storage(self) -> None:
        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="unused/authorized/path",
        )
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository({"catalog-dataset": payload}),
        )
        events: list[str] = []

        class FakeQuerySession:
            def read_widget(self, _widget_type: str, config: dict[str, object]):
                return {
                    "config": {
                        **config,
                        "dataMode": "server_aggregated",
                        "sourceConfig": dict(config),
                    },
                    "data": [{"category": "authorized", "amount": 1}],
                }

            def close(self) -> None:
                return None

        def create_session(_payload: object, *, remote_budget: object) -> FakeQuerySession:
            self.assertIsNotNone(remote_budget)
            events.append("storage")
            return FakeQuerySession()

        with (
            patch(
                "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.dashboard_dataset_access.require_governed_access",
                side_effect=lambda *_args, **_kwargs: events.append("governance"),
            ),
            patch(
                "app.services.dashboard_dataset_access.require_permission",
                side_effect=lambda *_args, **_kwargs: events.append("permission"),
            ),
            patch(
                "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession",
                side_effect=create_session,
            ),
        ):
            response = render_runtime_widget(service, runtime_widget())

        self.assertEqual(events, ["governance", "permission", "storage"])
        self.assertEqual(response.data, [{"category": "authorized", "amount": 1}])

    def test_runtime_permission_denial_never_opens_dataset_storage(self) -> None:
        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="must/not/be/opened",
        )
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository({"catalog-dataset": payload}),
        )
        events: list[str] = []

        def deny_permission(*_args: object, **_kwargs: object) -> None:
            events.append("permission")
            raise ApiError(ErrorCode.FORBIDDEN, "denied", 403)

        with (
            patch(
                "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.dashboard_dataset_access.require_governed_access",
                side_effect=lambda *_args, **_kwargs: events.append("governance"),
            ),
            patch(
                "app.services.dashboard_dataset_access.require_permission",
                side_effect=deny_permission,
            ),
            patch("app.services.dashboard_dataset_access.safe_record_audit_event"),
            patch(
                "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession"
            ) as query_session,
        ):
            response = render_runtime_widget(service, runtime_widget())

        self.assertEqual(events, ["governance", "permission"])
        query_session.assert_not_called()
        self.assertEqual(response.data, [])
        self.assertEqual(response.config.error, DASHBOARD_DATA_FORBIDDEN)

    def test_runtime_governance_lock_stops_before_permission_and_storage(self) -> None:
        payload = catalog_dataset_payload(
            storage_format="csv",
            storage_location="must/not/be-opened",
        )
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository({"catalog-dataset": payload}),
        )

        with (
            patch(
                "app.services.dashboard_batch_widget_loader.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.dashboard_dataset_access.require_governed_access",
                side_effect=ApiError(ErrorCode.FORBIDDEN, "locked", 403),
            ),
            patch(
                "app.services.dashboard_dataset_access.require_permission"
            ) as require_permission,
            patch(
                "app.services.dashboard_batch_widget_loader.DashboardDatasetQuerySession"
            ) as query_session,
        ):
            response = render_runtime_widget(service, runtime_widget())

        require_permission.assert_not_called()
        query_session.assert_not_called()
        self.assertEqual(response.data, [])
        self.assertEqual(response.config.error, DASHBOARD_DATA_FORBIDDEN)

    def test_deleted_catalog_dataset_is_empty_but_sql_snapshot_is_preserved(self) -> None:
        service = DashboardRuntimeService(SimpleNamespace(), FakeCatalogRepository({}))
        deleted_catalog_widget = runtime_widget(
            data=[{"category": "must-not-leak", "amount": 999}],
        )
        sql_rows = [{"category": f"row-{index}", "amount": index} for index in range(525)]
        sql_snapshot_widget = runtime_widget(
            dataset_id="sql-result-dataset",
            query_id="sql-run-1",
            data=sql_rows,
        )

        deleted_response = render_runtime_widget(service, deleted_catalog_widget)
        sql_response = render_runtime_widget(service, sql_snapshot_widget)

        self.assertEqual(deleted_response.data, [])
        self.assertEqual(deleted_response.config.error, DASHBOARD_DATA_UNAVAILABLE)
        self.assertEqual(len(sql_response.data), MAX_EXPLICIT_WIDGET_ROWS)
        self.assertEqual(sql_response.data[0]["category"], "row-0")
        self.assertIsNone(sql_response.config.error)

    def test_materialization_mode_uses_explicit_value_then_source_kind_fallback(self) -> None:
        cases = [
            ({"materializationMode": "delta", "sourceKind": "etl"}, "delta"),
            ({"materializationMode": "snapshot", "sourceKind": "kafka"}, "snapshot"),
            ({"materializationMode": "unexpected", "sourceKind": "kafka"}, "snapshot"),
            ({"materializationMode": "snapshot", "materialization_mode": "delta"}, "snapshot"),
            ({"materializationMode": "", "materialization_mode": "delta"}, "delta"),
            ({"sourceKind": "kafka"}, "delta"),
            ({"sourceKind": "kafka", "source_kind": "etl"}, "delta"),
            ({"sourceKind": "", "source_kind": "kafka"}, "delta"),
            ({"sourceKind": "etl"}, "snapshot"),
            ({}, "snapshot"),
        ]
        for run, expected in cases:
            with self.subTest(run=run):
                self.assertEqual(canonical_materialization_mode(run), expected)

    def test_active_segments_match_snapshot_and_kafka_delta_boundaries(self) -> None:
        dataset = {
            "storageFormat": "csv",
            "storageLocation": "fallback",
            "materializationRuns": [
                {
                    "runId": "kafka-newest",
                    "sourceKind": "kafka",
                    "status": "success",
                    "storageFormat": "csv",
                    "storageLocation": "segment-kafka",
                },
                {
                    "materializationMode": "delta",
                    "runId": "etl-delta",
                    "sourceKind": "etl",
                    "status": "success",
                    "storageFormat": "csv",
                    "storageLocation": "segment-delta",
                },
                {
                    "materializationMode": "snapshot",
                    "runId": "snapshot",
                    "sourceKind": "etl",
                    "status": "success",
                    "storageFormat": "csv",
                    "storageLocation": "segment-snapshot",
                },
                {
                    "materializationMode": "delta",
                    "runId": "obsolete",
                    "status": "success",
                    "storageFormat": "csv",
                    "storageLocation": "segment-obsolete",
                },
            ],
        }

        self.assertEqual(
            dataset_storage_segments(dataset),
            [
                ("segment-snapshot", "csv"),
                ("segment-delta", "csv"),
                ("segment-kafka", "csv"),
            ],
        )

        dataset["materializationRuns"] = [
            {
                "runId": "etl-no-mode",
                "sourceKind": "etl",
                "status": "success",
                "storageFormat": "csv",
                "storageLocation": "segment-etl-snapshot",
            },
            {
                "materializationMode": "delta",
                "runId": "older",
                "status": "success",
                "storageFormat": "csv",
                "storageLocation": "segment-older",
            },
        ]
        self.assertEqual(
            dataset_storage_segments(dataset),
            [("segment-etl-snapshot", "csv")],
        )

    def test_s3_allowlist_is_checked_before_creating_a_remote_client(self) -> None:
        budget = DashboardRemoteScanBudget(max_bytes=1024, max_objects=10)
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "allowed-bucket"}, clear=True),
            patch.object(dashboard_physical_data, "build_dashboard_s3_client") as build_client,
            self.assertRaises(ApiError) as raised,
        ):
            preflight_dashboard_s3_segments(
                {"id": "catalog-dataset"},
                [("s3://blocked-bucket/path", "parquet")],
                budget,
            )

        build_client.assert_not_called()
        self.assertEqual(raised.exception.code, DASHBOARD_DATA_UNAVAILABLE)
        self.assertIn("allowlisted", str(raised.exception.details.get("reason")))

    def test_s3_byte_budget_is_cumulative_across_active_segments(self) -> None:
        client = FakeDashboardS3Client({
            "first/": [{"Key": "first/part-1.parquet", "Size": 60}],
            "second/": [{"Key": "second/part-2.parquet", "Size": 50}],
        })
        budget = DashboardRemoteScanBudget(max_bytes=100, max_objects=10)
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "asklake-output"}, clear=True),
            patch.object(
                dashboard_physical_data,
                "build_dashboard_s3_client",
                return_value=client,
            ),
            self.assertRaises(ApiError) as raised,
        ):
            preflight_dashboard_s3_segments(
                {"id": "catalog-dataset"},
                [
                    ("s3://asklake-output/first", "parquet"),
                    ("s3://asklake-output/second", "parquet"),
                ],
                budget,
            )

        self.assertEqual(budget.used_bytes, 60)
        self.assertEqual(budget.used_objects, 1)
        self.assertIn("byte budget", str(raised.exception.details.get("reason")))

    def test_s3_object_budget_stops_large_prefix_listing(self) -> None:
        client = FakeDashboardS3Client({
            "many/": [
                {"Key": "many/part-1.csv", "Size": 10},
                {"Key": "many/part-2.csv", "Size": 10},
            ],
        })
        budget = DashboardRemoteScanBudget(max_bytes=100, max_objects=1)
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "asklake-output"}, clear=True),
            patch.object(
                dashboard_physical_data,
                "build_dashboard_s3_client",
                return_value=client,
            ),
            self.assertRaises(ApiError) as raised,
        ):
            preflight_dashboard_s3_segments(
                {"id": "catalog-dataset"},
                [("s3://asklake-output/many", "csv")],
                budget,
            )

        self.assertEqual(budget.used_objects, 1)
        self.assertIn("object budget", str(raised.exception.details.get("reason")))

    def test_duckdb_resource_limits_are_applied_from_bounded_environment_values(self) -> None:
        connection = duckdb.connect(database=":memory:")
        try:
            with patch.dict(
                os.environ,
                {
                    "ASKLAKE_DASHBOARD_DUCKDB_MEMORY_BYTES": str(64 * 1024 * 1024),
                    "ASKLAKE_DASHBOARD_DUCKDB_TEMP_BYTES": str(32 * 1024 * 1024),
                    "ASKLAKE_DASHBOARD_DUCKDB_THREADS": "1",
                },
                clear=True,
            ):
                configure_dashboard_duckdb_resources(connection)
            settings = connection.execute(
                "SELECT current_setting('memory_limit'), "
                "current_setting('max_temp_directory_size'), current_setting('threads')"
            ).fetchone()
        finally:
            connection.close()

        self.assertEqual(settings, ("64.0 MiB", "32.0 MiB", 1))

    def test_duckdb_query_timeout_interrupts_the_connection(self) -> None:
        connection = InterruptibleDuckDbConnection()
        started_at = time.monotonic()

        with self.assertRaises(duckdb.Error):
            execute_dashboard_query(
                connection,
                "SELECT 1",
                timeout_seconds=0.01,
            )

        self.assertTrue(connection.interrupted)
        self.assertLess(time.monotonic() - started_at, 0.5)

    def test_trino_query_timeout_cancels_the_last_continuation(self) -> None:
        client = EndlessDashboardTrinoClient()

        with self.assertRaisesRegex(RuntimeError, "execution deadline"):
            dashboard_physical_data.execute_trino_rows(
                client,  # type: ignore[arg-type]
                "SELECT 1",
                timeout_seconds=0.001,
            )

        self.assertEqual(
            client.cancelled,
            ["http://trino:8080/v1/statement/query/1"],
        )

    def test_httpfs_is_prepared_by_the_image_without_runtime_install(self) -> None:
        backend_root = Path(__file__).resolve().parents[1]
        service_source = (
            backend_root / "app" / "services" / "dashboard_physical_data.py"
        ).read_text(encoding="utf-8")
        dockerfile = (backend_root / "Dockerfile").read_text(encoding="utf-8")

        self.assertNotIn('execute("INSTALL httpfs")', service_source)
        self.assertIn("INSTALL httpfs", dockerfile)
        self.assertIn("INSTALL aws", dockerfile)

    def test_server_runtime_config_is_not_persisted_over_the_editable_count_config(self) -> None:
        service = DashboardRuntimeService(SimpleNamespace(), FakeCatalogRepository())
        config = DonutChartWidgetConfig.model_validate({
            "aggregation": "sum",
            "color": {"colors": ["#dc2626"]},
            "dataMode": "server_aggregated",
            "labelKey": "category",
            "sourceConfig": {
                "aggregation": "count",
                "color": {"colors": ["#2563eb"]},
                "labelKey": "category",
                "valueKey": "",
            },
            "valueKey": DASHBOARD_VALUE_ALIAS,
        })

        persisted = service._config_to_json(DashboardRuntimeWidgetType.DONUT_CHART, config)

        self.assertEqual(persisted["aggregation"], "count")
        self.assertEqual(persisted["valueKey"], "")
        self.assertEqual(persisted["color"], {"colors": ["#dc2626"]})
        self.assertNotIn("dataMode", persisted)
        self.assertNotIn("sourceConfig", persisted)

    def test_every_existing_widget_type_has_a_bounded_physical_query(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text(
                "category,series,event_date,amount\n"
                "phones,web,2026-06-01,4\n"
                "phones,store,2026-06-15,6\n"
                "accessories,web,2026-07-01,3\n",
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_all_widgets",
                sample_rows=[["sample-only", "sample-only", "2000-01-01", "999"]],
                storage_format="csv",
                storage_location=str(root),
            )
            cases = {
                "metric": {"aggregation": "sum", "valueKey": "amount"},
                "table": {"columns": ["category", "amount"], "limit": 2},
                "bar_chart": {"aggregation": "sum", "groupKey": "series", "xKey": "category", "yKey": "amount"},
                "line_chart": {"aggregation": "sum", "dateUnit": "month", "seriesKey": "series", "xKey": "event_date", "yKey": "amount"},
                "area_chart": {"aggregation": "sum", "dateUnit": "month", "seriesKey": "series", "xKey": "event_date", "yKey": "amount"},
                "donut_chart": {"aggregation": "sum", "labelKey": "category", "valueKey": "amount"},
                "pie_chart": {"aggregation": "sum", "labelKey": "category", "valueKey": "amount"},
                "radial_bar_chart": {"aggregation": "avg", "labelKey": "category", "valueKey": "amount"},
                "heatmap_chart": {"aggregation": "sum", "valueKey": "amount", "xKey": "category", "yKey": "series"},
                "treemap_chart": {"aggregation": "sum", "labelKey": "category", "valueKey": "amount"},
            }
            session = DashboardDatasetQuerySession(dataset)
            try:
                for widget_type, config in cases.items():
                    with self.subTest(widget_type=widget_type):
                        result = session.read_widget(widget_type, config)
                        self.assertGreater(len(result["data"]), 0)
                        self.assertLessEqual(len(result["data"]), 500)
                        self.assertEqual(result["config"]["sourceConfig"], config)
            finally:
                session.close()

    def test_parquet_physical_data_is_read_without_sample_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            parquet_path = root / "part.parquet"
            connection = duckdb.connect(database=":memory:")
            try:
                connection.execute(
                    "COPY (SELECT * FROM (VALUES ('phones', 4), ('phones', 6)) rows(category, amount)) "
                    f"TO '{parquet_path.as_posix()}' (FORMAT PARQUET)"
                )
            finally:
                connection.close()
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_parquet",
                sample_rows=[["sample-only", 999]],
                storage_format="parquet",
                storage_location=str(root),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                result = session.read_widget("metric", {"aggregation": "sum", "valueKey": "amount"})
            finally:
                session.close()

        self.assertEqual(result["data"], [{"amount": 10.0}])


if __name__ == "__main__":
    unittest.main()
