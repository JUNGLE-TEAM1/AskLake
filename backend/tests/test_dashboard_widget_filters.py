from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import duckdb
from pydantic import ValidationError

from app.schemas.dashboard import (
    BarChartWidgetConfig,
    DashboardRuntimeWidgetType,
    DashboardWidgetAggregation,
    DashboardWidgetFilter,
    DashboardWidgetColorConfig,
    MetricWidgetConfig,
)
from app.services.dashboard_physical_data import (
    DashboardDatasetQuerySession,
    dashboard_aggregate_state_query,
    dashboard_table_query,
)
from app.services.dashboard_runtime_service import DashboardRuntimeService
from app.services.dashboard_widget_config import dashboard_widget_config_to_json


class DashboardWidgetFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.parquet_path = Path(self.temporary_directory.name) / "widget_filters.parquet"
        connection = duckdb.connect(database=":memory:")
        try:
            escaped_path = str(self.parquet_path).replace("'", "''")
            connection.execute(
                "COPY (SELECT * FROM (VALUES "
                "('Wearable Technology', 'Smartwatches', 10.0, TIMESTAMP '2026-07-01 00:00:00'), "
                "('Wearable Technology', 'Fitness Trackers', 5.0, TIMESTAMP '2026-07-02 00:00:00'), "
                "('Electronics', 'Smartwatches', 100.0, TIMESTAMP '2026-07-03 00:00:00')"
                ") AS source(category, subcategory, amount, event_time)) "
                f"TO '{escaped_path}' (FORMAT PARQUET)"
            )
        finally:
            connection.close()
        self.dataset = {
            "id": "widget-filter-dataset",
            "schema": [
                ["category", "VARCHAR"],
                ["subcategory", "VARCHAR"],
                ["amount", "DOUBLE"],
                ["event_time", "TIMESTAMP"],
            ],
            "storageFormat": "parquet",
            "storageLocation": str(self.parquet_path),
        }

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_table_and_aggregation_apply_widget_filters_before_limit_and_grouping(self) -> None:
        session = DashboardDatasetQuerySession(self.dataset)
        try:
            table = session.read_widget("table", {
                "columns": ["category", "subcategory", "amount"],
                "filters": [
                    {
                        "id": "category-filter",
                        "column": "category",
                        "operator": "eq",
                        "value": "Wearable Technology",
                    },
                    {
                        "id": "subcategory-filter",
                        "column": "subcategory",
                        "operator": "eq",
                        "value": "Smartwatches",
                    },
                ],
                "limit": 100,
            })
            chart = session.read_widget("bar_chart", {
                "aggregation": "sum",
                "filters": [{
                    "id": "category-filter",
                    "column": "category",
                    "operator": "eq",
                    "value": "Wearable Technology",
                }],
                "xKey": "subcategory",
                "yKey": "amount",
            })
        finally:
            session.close()

        self.assertEqual(table["data"], [{
            "category": "Wearable Technology",
            "subcategory": "Smartwatches",
            "amount": 10.0,
        }])
        self.assertEqual(chart["data"], [
            {"subcategory": "Smartwatches", "amount": 10.0},
            {"subcategory": "Fitness Trackers", "amount": 5.0},
        ])
        self.assertEqual(
            chart["config"]["sourceConfig"]["filters"][0]["value"],
            "Wearable Technology",
        )

    def test_filter_values_are_dynamic_searchable_and_narrowed_by_previous_filters(self) -> None:
        session = DashboardDatasetQuerySession(self.dataset)
        try:
            result = session.read_filter_values(
                "subcategory",
                context_filters=[{
                    "id": "category-filter",
                    "column": "category",
                    "operator": "eq",
                    "value": "Wearable Technology",
                }],
                search="watch",
                limit=50,
            )
        finally:
            session.close()

        self.assertEqual(result, {"truncated": False, "values": ["Smartwatches"]})

    def test_numeric_and_date_filters_use_catalog_column_types(self) -> None:
        session = DashboardDatasetQuerySession(self.dataset)
        try:
            result = session.read_widget("table", {
                "columns": ["category", "amount", "event_time"],
                "filters": [
                    {
                        "id": "amount-filter",
                        "column": "amount",
                        "operator": "between",
                        "values": [6, 20],
                    },
                    {
                        "id": "date-filter",
                        "column": "event_time",
                        "operator": "lte",
                        "value": "2026-07-02T23:59:59",
                    },
                ],
            })
        finally:
            session.close()

        self.assertEqual(len(result["data"]), 1)
        self.assertEqual(result["data"][0]["amount"], 10.0)

    def test_filter_values_are_sql_literals_and_never_raw_predicates(self) -> None:
        session = DashboardDatasetQuerySession(self.dataset)
        try:
            result = session.read_widget("table", {
                "columns": ["category"],
                "filters": [{
                    "id": "injection-filter",
                    "column": "category",
                    "operator": "eq",
                    "value": "Wearable Technology' OR 1=1 --",
                }],
            })
        finally:
            session.close()

        self.assertEqual(result["data"], [])

    def test_invalid_column_and_operator_value_shapes_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "column does not exist"):
            dashboard_table_query(
                '"dataset"',
                {"category"},
                {
                    "columns": ["category"],
                    "filters": [{
                        "id": "unknown-column",
                        "column": "missing",
                        "operator": "eq",
                        "value": "anything",
                    }],
                },
            )
        with self.assertRaises(ValidationError):
            MetricWidgetConfig.model_validate({
                "aggregation": "count",
                "filters": [{
                    "id": "bad-between",
                    "column": "amount",
                    "operator": "between",
                    "values": [1],
                }],
                "valueKey": "amount",
            })

    def test_aggregate_state_combines_revision_and_widget_filters(self) -> None:
        query, state = dashboard_aggregate_state_query(
            '"dataset"',
            {"category", "amount"},
            "bar_chart",
            {
                "aggregation": "sum",
                "filters": [{
                    "id": "category-filter",
                    "column": "category",
                    "operator": "eq",
                    "value": "Wearable Technology",
                }],
                "xKey": "category",
                "yKey": "amount",
            },
            where_sql=' WHERE "_asklake_run_id" = \'run-1\'',
            column_types={"amount": "number", "category": "string"},
        )

        self.assertIn('"_asklake_run_id" = \'run-1\'', query)
        self.assertIn("CAST(\"category\" AS VARCHAR) = 'Wearable Technology'", query)
        self.assertEqual(state["sourceConfig"]["filters"][0]["id"], "category-filter")

    def test_filter_change_produces_a_new_calculation_version(self) -> None:
        base_config = {
            "aggregation": "sum",
            "filters": [{
                "id": "category-filter",
                "column": "category",
                "operator": "eq",
                "value": "Wearable Technology",
            }],
            "xKey": "category",
            "yKey": "amount",
        }
        first = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-1",
            base_config,
        )
        second = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-1",
            {
                **base_config,
                "filters": [{
                    **base_config["filters"][0],
                    "value": "Electronics",
                }],
            },
        )

        self.assertNotEqual(first, second)

    def test_runtime_source_config_preserves_filters_when_widget_is_persisted_again(self) -> None:
        persisted = dashboard_widget_config_to_json(
            DashboardRuntimeWidgetType.BAR_CHART,
            BarChartWidgetConfig(
                aggregation=DashboardWidgetAggregation.SUM,
                color=DashboardWidgetColorConfig(colors=["#2563eb"]),
                data_mode="server_aggregated",
                source_config={
                    "aggregation": "sum",
                    "filters": [{
                        "id": "category-filter",
                        "column": "category",
                        "operator": "eq",
                        "value": "Wearable Technology",
                    }],
                    "xKey": "category",
                    "yKey": "amount",
                },
                x_key="category",
                y_key="amount",
            ),
        )

        self.assertEqual(persisted["filters"][0]["value"], "Wearable Technology")

    def test_filter_schema_rejects_duplicate_ids_and_more_than_five_conditions(self) -> None:
        filter_value = DashboardWidgetFilter(
            id="same-filter",
            column="category",
            operator="eq",
            value="Wearable Technology",
        )
        with self.assertRaises(ValidationError):
            MetricWidgetConfig(
                aggregation=DashboardWidgetAggregation.COUNT,
                filters=[filter_value, filter_value],
                value_key="amount",
            )
        with self.assertRaises(ValidationError):
            MetricWidgetConfig(
                aggregation=DashboardWidgetAggregation.COUNT,
                filters=[
                    DashboardWidgetFilter(
                        id=f"filter-{index}",
                        column="category",
                        operator="eq",
                        value="Wearable Technology",
                    )
                    for index in range(6)
                ],
                value_key="amount",
            )
