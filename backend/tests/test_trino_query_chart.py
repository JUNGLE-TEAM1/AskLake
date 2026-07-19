from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.schemas.trino import (
    TrinoQueryRunChartRequest,
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
)
from app.services.trino_query_run_service import TrinoQueryRunService


class TrinoQueryChartTests(unittest.TestCase):
    def _service(
        self,
        response: TrinoQueryRunResponse,
        pages: list[SimpleNamespace],
        result_storage: object | None = None,
    ) -> TrinoQueryRunService:
        repository = SimpleNamespace(
            db=SimpleNamespace(),
            list_result_pages=Mock(return_value=pages),
        )
        service = TrinoQueryRunService(
            repository=repository,  # type: ignore[arg-type]
            catalog_repository=SimpleNamespace(),  # type: ignore[arg-type]
            client=SimpleNamespace(),  # type: ignore[arg-type]
            result_storage=result_storage or SimpleNamespace(),  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        service.run_store.load = Mock(return_value=response)  # type: ignore[method-assign]
        service.access_service.require_access_for_response = Mock()  # type: ignore[method-assign]
        return service

    def test_chart_aggregates_every_persisted_result_page(self) -> None:
        columns = ["event_date", "metric_name", "metric_value"]
        first_page = [["2026-06-01", "impressions", 1] for _ in range(100)]
        second_page = [
            *[["2026-06-01", "impressions", 2] for _ in range(40)],
            *[["2026-06-01", "clicks", 3] for _ in range(10)],
        ]
        pages = [
            SimpleNamespace(storage_backend="s3", object_key="page-0", checksum="sum-0", columns=columns, rows=[]),
            SimpleNamespace(storage_backend="s3", object_key="page-1", checksum="sum-1", columns=columns, rows=[]),
        ]
        result_storage = SimpleNamespace(
            read_page=Mock(side_effect=[(columns, first_page), (columns, second_page)]),
        )
        response = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="run",
            query="SELECT event_date, metric_name, metric_value FROM events",
            result=TrinoQueryRunResult(
                columns=columns,
                rowCount=150,
                storage="s3",
                storageStatus="available",
            ),
            runId="trino_full_1",
            status="succeeded",
            submittedAt="2026-07-19T00:00:00Z",
        )
        service = self._service(response, pages, result_storage)
        request = TrinoQueryRunChartRequest(
            type="line_chart",
            config={
                "aggregation": "sum",
                "color": {"colors": ["#2563eb"]},
                "dateUnit": "day",
                "seriesKey": "metric_name",
                "xKey": "event_date",
                "yKey": "metric_value",
            },
        )

        with patch("app.services.trino_query_results.safe_record_audit_event"):
            result = service.prepare_chart_data(response.run_id, request, ActorContext(id="user-1"))

        self.assertEqual(result.source_row_count, 150)
        self.assertEqual(result.group_count, 2)
        values_by_metric = {row["metric_name"]: row["metric_value"] for row in result.data}
        self.assertEqual(values_by_metric, {"clicks": 30.0, "impressions": 180.0})
        self.assertEqual(result.config["dataMode"], "server_aggregated")
        self.assertEqual(result_storage.read_page.call_count, 2)
        service.access_service.require_access_for_response.assert_called_once()  # type: ignore[attr-defined]

    def test_preview_run_cannot_be_presented_as_a_full_result_chart(self) -> None:
        response = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="preview",
            query="SELECT * FROM events",
            result=TrinoQueryRunResult(
                columns=["event_id"],
                rowCount=100,
                storage="postgres",
                storageStatus="available",
            ),
            runId="trino_preview_1",
            status="succeeded",
            submittedAt="2026-07-19T00:00:00Z",
        )
        service = self._service(response, [])

        with self.assertRaises(ApiError) as raised:
            service.prepare_chart_data(
                response.run_id,
                TrinoQueryRunChartRequest(
                    type="metric",
                    config={"aggregation": "count", "valueKey": "event_id"},
                ),
                ActorContext(id="user-1"),
            )

        self.assertEqual(raised.exception.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(str(raised.exception.code), "ErrorCode.RESULT_PAGE_NOT_READY")

    def test_chart_rejects_a_dimension_that_exceeds_the_group_budget(self) -> None:
        columns = ["event_id", "value"]
        rows = [[f"evt-{index}", 1] for index in range(10_001)]
        page = SimpleNamespace(
            storage_backend="postgres",
            object_key=None,
            checksum=None,
            columns=columns,
            rows=rows,
        )
        response = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="run",
            query="SELECT event_id, value FROM events",
            result=TrinoQueryRunResult(
                columns=columns,
                rowCount=len(rows),
                storage="s3",
                storageStatus="available",
            ),
            runId="trino_full_group_limit",
            status="succeeded",
            submittedAt="2026-07-19T00:00:00Z",
        )
        service = self._service(response, [page])

        with self.assertRaises(ApiError) as raised:
            service.prepare_chart_data(
                response.run_id,
                TrinoQueryRunChartRequest(
                    type="bar_chart",
                    config={
                        "aggregation": "sum",
                        "color": {"colors": ["#2563eb"]},
                        "xKey": "event_id",
                        "yKey": "value",
                    },
                ),
                ActorContext(id="user-1"),
            )

        self.assertEqual(raised.exception.status_code, status.HTTP_422_UNPROCESSABLE_ENTITY)
        self.assertIn("10,000", raised.exception.message)


if __name__ == "__main__":
    unittest.main()
