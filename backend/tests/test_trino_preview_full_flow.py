from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.schemas.trino import (
    CreateTrinoFullResultRequest,
    QueryRunSubmitRequest,
    SubmitTrinoQueryRunRequest,
    TrinoClientPage,
    TrinoQueryEstimate,
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
)
from app.services.trino_query_run_service import TrinoQueryRunService, build_run_response


class InlineResultRepository:
    def __init__(self) -> None:
        self.pages: list[dict[str, object]] = []
        self.db = SimpleNamespace()

    def get_result_page_by_source_uri(self, _run_id: str, _source_next_uri: str):
        return None

    def count_result_pages(self, _run_id: str) -> int:
        return len(self.pages)

    def save_result_page(self, **page: object) -> None:
        self.pages.append(page)

    def total_result_bytes(self, _run_id: str) -> int:
        return sum(int(page["byte_size"]) for page in self.pages)

    def total_result_rows(self, _run_id: str) -> int:
        return sum(len(page["rows"]) for page in self.pages)  # type: ignore[arg-type]


class RejectingObjectStorage:
    def write_page(self, **_kwargs: object):
        raise AssertionError("preview result must not be written to object storage")


class TrinoPreviewFullFlowTests(unittest.TestCase):
    def test_public_query_request_cannot_bypass_preview_mode(self) -> None:
        request = QueryRunSubmitRequest(
            datasetId="dataset-1",
            limit=500,
            mode="run",
            query="SELECT * FROM events",
        )

        normalized = request.trino_request()

        self.assertEqual(normalized.mode, "preview")
        self.assertEqual(normalized.preview_limit, 100)

    def test_preview_executes_a_limit_but_persists_the_unbounded_sql_recipe(self) -> None:
        repository = InlineResultRepository()
        repository.reserve_trino_submission = Mock(return_value=SimpleNamespace(outcome="created", payload=None))
        client = SimpleNamespace(submit=Mock(return_value=TrinoClientPage(
            columns=["event_id"],
            queryId="query-1",
            rawStats={"state": "FINISHED", "outputPositions": 1},
            rows=[["evt-1"]],
            state="FINISHED",
        )))
        service = TrinoQueryRunService(
            repository=repository,  # type: ignore[arg-type]
            catalog_repository=SimpleNamespace(),  # type: ignore[arg-type]
            client=client,  # type: ignore[arg-type]
            result_storage=RejectingObjectStorage(),  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        context_dataset = SimpleNamespace(id="dataset-1", name="Events")
        service._resolve_context = Mock(return_value=[context_dataset])  # type: ignore[method-assign]
        service._require_query_access = Mock()  # type: ignore[method-assign]
        service._build_query_estimate = Mock(return_value=TrinoQueryEstimate(riskLevel="low"))  # type: ignore[method-assign]
        service._save_response = Mock()  # type: ignore[method-assign]
        compiled_query = 'SELECT * FROM "iceberg"."asklake"."events"'

        with (
            patch("app.services.trino_query_run_service.compile_trino_read_query", return_value=(compiled_query, [])),
            patch("app.services.trino_query_run_service.safe_record_audit_event"),
        ):
            service.submit(SubmitTrinoQueryRunRequest(
                baseDatasetId="dataset-1",
                mode="preview",
                query="SELECT * FROM events",
            ), ActorContext(id="user-1", name="User"))

        executed_query = client.submit.call_args.args[0]
        self.assertIn('AS "_asklake_preview" LIMIT 100', executed_query)
        self.assertEqual(service._save_response.call_args.kwargs["compiled_query"], compiled_query)  # type: ignore[attr-defined]

    def test_preview_page_is_bounded_and_saved_inline(self) -> None:
        repository = InlineResultRepository()
        service = TrinoQueryRunService(
            repository=repository,  # type: ignore[arg-type]
            catalog_repository=SimpleNamespace(),  # type: ignore[arg-type]
            client=SimpleNamespace(),  # type: ignore[arg-type]
            result_storage=RejectingObjectStorage(),  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        request = SubmitTrinoQueryRunRequest(
            baseDatasetId="dataset-1",
            mode="preview",
            query="SELECT * FROM events",
        )
        page = TrinoClientPage(
            columns=["event_id"],
            queryId="query-1",
            rawStats={"state": "FINISHED", "outputPositions": 2},
            rows=[["evt-1"], ["evt-2"]],
            state="FINISHED",
        )
        response = build_run_response(request, page, ActorContext(id="user-1"), 300)

        stored = service._finalize_result_storage(service._store_result_page(response, page))

        self.assertEqual(len(repository.pages), 1)
        self.assertEqual(repository.pages[0]["rows"], [["evt-1"], ["evt-2"]])
        self.assertEqual(stored.mode, "preview")
        self.assertIsNotNone(stored.result)
        self.assertEqual(stored.result.storage, "postgres")  # type: ignore[union-attr]
        self.assertEqual(stored.result.storage_status, "available")  # type: ignore[union-attr]

    def test_full_result_request_links_a_new_run_to_the_preview(self) -> None:
        repository = SimpleNamespace(
            db=SimpleNamespace(),
            get_latest_full_result_run_payload=Mock(return_value=None),
        )
        service = TrinoQueryRunService(
            repository=repository,  # type: ignore[arg-type]
            catalog_repository=SimpleNamespace(),  # type: ignore[arg-type]
            client=SimpleNamespace(),  # type: ignore[arg-type]
            result_storage=SimpleNamespace(),  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        preview = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="preview",
            query="SELECT * FROM events",
            referenceDatasetIds=[],
            result=TrinoQueryRunResult(columns=["event_id"], storage="postgres", storageStatus="available"),
            runId="trino-preview",
            status="succeeded",
            submittedAt="2026-07-16T00:00:00Z",
            submittedByUserId="user-1",
        )
        expected = preview.model_copy(update={"mode": "run", "run_id": "trino-full", "source_run_id": preview.run_id})
        service.get = Mock(return_value=preview)  # type: ignore[method-assign]
        service._resolve_context = Mock(return_value=[SimpleNamespace(id="dataset-1")])  # type: ignore[method-assign]
        service.submit = Mock(return_value=expected)  # type: ignore[method-assign]

        result = service.create_full_result_run(
            preview.run_id,
            CreateTrinoFullResultRequest(clientRequestId="full-request-1"),
            ActorContext(id="user-1", name="User"),
        )

        self.assertEqual(result.run_id, "trino-full")
        submitted_request = service.submit.call_args.args[0]  # type: ignore[attr-defined]
        self.assertEqual(submitted_request.mode, "run")
        self.assertEqual(submitted_request.source_run_id, preview.run_id)
        self.assertEqual(submitted_request.query, preview.query)

    def test_full_result_request_reuses_an_active_linked_run(self) -> None:
        preview = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="preview",
            query="SELECT * FROM events",
            result=TrinoQueryRunResult(columns=["event_id"], storage="postgres", storageStatus="available"),
            runId="trino-preview",
            status="succeeded",
            submittedAt="2026-07-16T00:00:00Z",
            submittedByUserId="user-1",
        )
        active_full_run = TrinoQueryRunResponse(
            baseDatasetId="dataset-1",
            mode="run",
            query=preview.query,
            result=TrinoQueryRunResult(columns=["event_id"], storage="s3", storageStatus="collecting"),
            runId="trino-full",
            sourceRunId=preview.run_id,
            status="running",
            submittedAt="2026-07-16T00:00:01Z",
            submittedByUserId="user-1",
        )
        repository = SimpleNamespace(
            db=SimpleNamespace(),
            get_latest_full_result_run_payload=Mock(
                return_value=active_full_run.model_dump(by_alias=True, mode="json"),
            ),
        )
        service = TrinoQueryRunService(
            repository=repository,  # type: ignore[arg-type]
            catalog_repository=SimpleNamespace(),  # type: ignore[arg-type]
            client=SimpleNamespace(),  # type: ignore[arg-type]
            result_storage=SimpleNamespace(),  # type: ignore[arg-type]
            runtime_settings=Settings(_env_file=None, trino_enabled=True),
        )
        service.get = Mock(return_value=preview)  # type: ignore[method-assign]
        service._require_access_for_response = Mock()  # type: ignore[method-assign]
        service.submit = Mock()  # type: ignore[method-assign]

        result = service.create_full_result_run(
            preview.run_id,
            CreateTrinoFullResultRequest(clientRequestId="full-request-2"),
            ActorContext(id="user-1", name="User"),
        )

        self.assertEqual(result.run_id, active_full_run.run_id)
        service.submit.assert_not_called()  # type: ignore[attr-defined]


if __name__ == "__main__":
    unittest.main()
