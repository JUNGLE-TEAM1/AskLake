from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.realtime import ReplaySnapshot, StreamIdentity, _event_stream
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.schemas.dashboard import DatasetFreshnessResponse
from app.schemas.realtime import RealtimeEventEnvelope
from app.services.clickhouse_client import ClickHouseRows
from app.services.dashboard_physical_data import DashboardDatasetQuerySession
from app.services.realtime_event_service import RealtimeEventHub


def dataset_payload(*, binding_epoch=7, duplicate=False):
    binding = {
        "role": "serving",
        "engine": "clickhouse",
        "status": "active",
        "bindingEpoch": binding_epoch,
        "versionId": "serving-v7",
        "pipelineVersionId": "pipeline-v7",
        "database": "asklake_realtime_v2",
        "table": "serving_current_v2",
    }
    bindings = [binding, dict(binding, versionId="serving-duplicate")] if duplicate else [binding]
    return {
        "id": "joined",
        "schema": [["region", "string"], ["amount", "double"]],
        "physicalBindings": bindings,
        "storageFormat": "iceberg",
    }


class _ClickHouse:
    def __init__(self, rows=None):
        self.queries = []
        self.rows = rows if rows is not None else [["seoul", "12.5"]]
        self.closed = False

    def query(self, query, **kwargs):
        self.queries.append((query, kwargs))
        return ClickHouseRows(["region", "amount"], self.rows)

    def close(self):
        self.closed = True


def event_v2(event_id: int, mutation: str = "upsert") -> RealtimeEventEnvelope:
    return RealtimeEventEnvelope(
        event_id=event_id,
        event_type="dataset.revision.committed",
        schema_version=2,
        scope_id="deployment",
        resource_type="dataset",
        resource_id="joined",
        aggregate_revision=event_id,
        occurred_at=datetime.now(UTC).isoformat(),
        correlation_id=f"materialization-{event_id}",
        invalidate=["dataset:joined"],
        payload={
            "bindingEpoch": 7,
            "materializationId": f"materialization-{event_id}",
            "mutationType": mutation,
            "sourceBoundary": {"partitions": []},
            "servingVersionId": "serving-v7",
            "pipelineVersionId": "pipeline-v7",
        },
    )


class DashboardClickHouseV2QueryTests(unittest.TestCase):
    def test_active_binding_queries_only_bounded_serving_current_projection(self) -> None:
        clickhouse = _ClickHouse()
        session = DashboardDatasetQuerySession(
            dataset_payload(),
            clickhouse_client=clickhouse,  # type: ignore[arg-type]
            expected_binding_epoch=7,
            query_timeout_seconds=3,
        )
        try:
            result = session.read_widget("table", {"columns": ["region", "amount"], "limit": 25})
        finally:
            session.close()

        query, options = clickhouse.queries[0]
        self.assertEqual(result["data"], [{"region": "seoul", "amount": "12.5"}])
        self.assertIn("serving_current_v2", query)
        self.assertIn("serving_dataset_id = 'joined'", query)
        self.assertIn("pipeline_version_id = 'pipeline-v7'", query)
        self.assertIn("JSON_VALUE(payload", query)
        self.assertIn("LIMIT 25", query)
        self.assertNotIn(" FINAL", query)
        self.assertEqual(options["timeout_seconds"], 3)

    def test_stale_or_ambiguous_active_binding_fails_closed(self) -> None:
        with self.assertRaises(ApiError) as stale:
            DashboardDatasetQuerySession(
                dataset_payload(), clickhouse_client=_ClickHouse(), expected_binding_epoch=8,
            )
        self.assertIn("stale", stale.exception.details["reason"])

        with self.assertRaises(ApiError) as ambiguous:
            DashboardDatasetQuerySession(
                dataset_payload(duplicate=True), clickhouse_client=_ClickHouse(), expected_binding_epoch=7,
            )
        self.assertIn("more than one", ambiguous.exception.details["reason"])

    def test_result_rows_are_bounded_even_if_server_returns_too_many(self) -> None:
        session = DashboardDatasetQuerySession(
            dataset_payload(),
            clickhouse_client=_ClickHouse(rows=[["x", "1"]] * 501),
            expected_binding_epoch=7,
        )
        try:
            with self.assertRaises(ApiError) as raised:
                session.read_widget("table", {"columns": ["region"], "limit": 500})
        finally:
            session.close()
        self.assertEqual(raised.exception.status_code, 503)

    def test_freshness_contract_exposes_binding_and_mutation_evidence(self) -> None:
        response = DatasetFreshnessResponse(
            dataset_id="joined",
            is_continuous=True,
            latest_revision=9,
            next_check_after_ms=1000,
            binding_epoch=7,
            active_serving_engine="clickhouse",
            active_serving_version_id="serving-v7",
            latest_source_boundary={"partitions": []},
            latest_checksum="checksum",
            latest_mutation_type="upsert",
        ).model_dump(by_alias=True)
        self.assertEqual(response["bindingEpoch"], 7)
        self.assertEqual(response["latestMutationType"], "upsert")


class DashboardSseV2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_permission_is_rechecked_before_each_replayed_event(self) -> None:
        hub = RealtimeEventHub()
        subscription = hub.subscribe(
            actor_key="actor",
            resources={("dataset", "joined")},
        )
        identity = StreamIdentity(
            actor=ActorContext(name="actor"), actor_key="actor", session_token=None,
            actor_name_header="actor", actor_role_header="viewer", actor_groups_header=None,
        )
        request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
        snapshot = ReplaySnapshot(10, 11, [event_v2(10, "append"), event_v2(11, "retract")])

        with (
            patch("app.api.realtime._load_replay_snapshot", return_value=snapshot),
            patch("app.api.realtime._stream_identity_is_authorized", side_effect=[True, False]),
        ):
            frames = [
                frame async for frame in _event_stream(
                    request=request,
                    subscription=subscription,
                    identity=identity,
                    dashboard_id="dashboard",
                    dataset_ids={"joined"},
                    initial_cursor=9,
                )
            ]

        self.assertEqual([item["event"] for item in frames], [
            "stream.ready", "dataset.revision.committed", "system.authorization_changed",
        ])
        payload = json.loads(frames[1]["data"])
        self.assertEqual(payload["schemaVersion"], 2)
        self.assertEqual(payload["payload"]["mutationType"], "append")
        self.assertTrue(subscription.closed)

    async def test_two_replicas_replay_the_same_durable_cursor_sequence(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(engine) as writer:
            repository = RealtimeEventRepository(writer, ensure_schema=True)
            now = datetime.now(UTC)
            for event_id, mutation in ((1, "append"), (2, "upsert"), (3, "replace")):
                repository.append(
                    event_type="dataset.revision.committed",
                    resource_type="dataset",
                    resource_id="joined",
                    aggregate_revision=event_id,
                    correlation_id=f"m-{event_id}",
                    idempotency_key=f"m-{event_id}",
                    invalidations=["dataset:joined"],
                    payload=event_v2(event_id, mutation).payload,
                    occurred_at=now + timedelta(microseconds=event_id),
                    schema_version=2,
                )
            writer.commit()
        sequences = []
        for _replica in range(2):
            with Session(engine) as reader:
                sequences.append([
                    event.event_id for event in RealtimeEventRepository(reader).replay(
                        after_cursor=0,
                        resources={("dataset", "joined")},
                        limit=10,
                    )
                ])
        engine.dispose()
        self.assertEqual(sequences, [[1, 2, 3], [1, 2, 3]])


if __name__ == "__main__":
    unittest.main()
