from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.services.dashboard_runtime_service import DashboardRuntimeService, MAX_EXPLICIT_WIDGET_ROWS
from app.services.sql_service import DASHBOARD_VALUE_ALIAS, DashboardDatasetQuerySession


class FakeCatalogRepository:
    def __init__(self, payloads=None):
        self.db = SimpleNamespace()
        self.payloads = payloads or {"catalog-dataset": {"id": "catalog-dataset"}}

    def get_dataset_payload(self, dataset_id: str):
        return self.payloads.get(dataset_id)


class DashboardPhysicalWidgetDataTests(unittest.TestCase):
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

    def test_catalog_widgets_ignore_client_rows_but_bounded_sql_snapshots_remain_supported(self) -> None:
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

    def test_required_chart_dimensions_are_rejected_instead_of_misaggregated(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text("category,amount\nphones,4\n", encoding="utf-8")
            dataset = SimpleNamespace(
                id="catalog-dataset",
                materialization_runs=[],
                name="dashboard_required_dimension",
                sample_rows=[],
                storage_format="csv",
                storage_location=str(root),
            )
            session = DashboardDatasetQuerySession(dataset)
            try:
                with self.assertRaisesRegex(ValueError, "requires xKey"):
                    session.read_widget("bar_chart", {
                        "aggregation": "sum",
                        "xKey": "",
                        "yKey": "amount",
                    })
            finally:
                session.close()

    def test_catalog_dataset_binding_requires_query_permission(self) -> None:
        catalog_repository = FakeCatalogRepository()
        service = DashboardRuntimeService(SimpleNamespace(), catalog_repository)
        dataset = SimpleNamespace(
            id="catalog-dataset",
            name="private_dataset",
            owner="dataset-owner",
            permission_grants=[],
        )

        with (
            patch(
                "app.services.dashboard_runtime_service.CatalogDatasetResponse.model_validate",
                return_value=dataset,
            ),
            patch(
                "app.services.dashboard_runtime_service.dataset_with_persisted_permission_grants",
                return_value=dataset,
            ),
            patch("app.services.dashboard_runtime_service.require_governed_access"),
            patch("app.services.dashboard_runtime_service.safe_record_audit_event"),
            self.assertRaises(ApiError) as context,
        ):
            service._require_dataset_query_permission(
                "catalog-dataset",
                ActorContext(name="dashboard-editor", role="viewer"),
                api_path="/api/dashboards/dashboard-1/draft/widgets/widget-1",
                http_method="PATCH",
            )

        self.assertEqual(context.exception.status_code, 403)

    def test_runtime_widget_response_replaces_stored_sample_data_with_physical_aggregation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text(
                "category,amount\nphones,4\nphones,6\naccessories,3\n",
                encoding="utf-8",
            )
            payload = {
                "description": "physical dashboard fixture",
                "downstream": [],
                "freshness": "latest",
                "id": "catalog-dataset",
                "layer": "GOLD",
                "lastUpdated": "2026-07-12T00:00:00Z",
                "materializationRuns": [],
                "name": "runtime_physical",
                "nextRefresh": "-",
                "owner": "analytics",
                "quality": "passed",
                "rag": False,
                "rows": "3",
                "sampleRows": [["sample-only", "999"]],
                "schema": [["category", "string"], ["amount", "double"]],
                "size": "1 KB",
                "source": "CSV",
                "status": "available",
                "storageFormat": "csv",
                "storageLocation": str(root),
                "tags": [],
                "upstream": [],
            }
            service = DashboardRuntimeService(
                SimpleNamespace(),
                FakeCatalogRepository({"catalog-dataset": payload}),
            )
            widget = SimpleNamespace(
                config={"aggregation": "sum", "xKey": "category", "yKey": "amount"},
                data=[{"category": "sample-only", "amount": 999}],
                dataset_id="catalog-dataset",
                id="widget-1",
                layout={"x": 0, "y": 0, "w": 4, "h": 3},
                page_id="page-1",
                query_id=None,
                title="Sales",
                type="bar_chart",
            )
            sessions = {}
            try:
                response = service._widget_to_schema(widget, sessions, {}, {}, {})
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


if __name__ == "__main__":
    unittest.main()
