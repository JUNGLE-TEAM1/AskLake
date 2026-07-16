import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.realtime import ReplaySnapshot, StreamIdentity, _domain_event, _event_stream
from app.core.auth_context import ActorContext
from app.core.config import settings
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.schemas.realtime import RealtimeEventEnvelope
from app.services.realtime_event_contract import validate_realtime_event
from app.services.realtime_event_service import (
    RealtimeConnectionLimitError,
    RealtimeEventDispatcher,
    RealtimeEventHub,
    RealtimeQueueOverflow,
)


def event_envelope(
    event_id: int,
    *,
    dataset_id: str = "dataset-live",
    revision: int | None = None,
) -> RealtimeEventEnvelope:
    return RealtimeEventEnvelope(
        event_id=event_id,
        event_type="dataset.revision.committed",
        schema_version=1,
        scope_id="deployment",
        resource_type="dataset",
        resource_id=dataset_id,
        aggregate_revision=revision if revision is not None else event_id,
        occurred_at=datetime.now(UTC).isoformat(),
        correlation_id=f"run-{event_id}",
        invalidate=[f"dataset:{dataset_id}:freshness"],
        payload={"runId": f"run-{event_id}", "commitKind": "stream"},
    )


class RealtimeEventRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        self.db = Session(self.engine)
        self.repository = RealtimeEventRepository(self.db, ensure_schema=True)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def append(self, key: str, *, dataset_id: str = "dataset-live"):
        return self.repository.append(
            event_type="dataset.revision.committed",
            resource_type="dataset",
            resource_id=dataset_id,
            aggregate_revision=1,
            correlation_id=f"run-{key}",
            idempotency_key=key,
            invalidations=[f"dataset:{dataset_id}:freshness"],
            payload={"runId": f"run-{key}", "commitKind": "stream"},
        )

    def test_append_is_idempotent_and_replay_is_resource_scoped(self) -> None:
        first, first_created = self.append("event-1")
        repeated, repeated_created = self.append("event-1")
        other, other_created = self.append("event-2", dataset_id="dataset-other")
        self.db.commit()

        replay = self.repository.replay(
            after_cursor=0,
            resources={("dataset", "dataset-live")},
            limit=10,
        )

        self.assertTrue(first_created)
        self.assertFalse(repeated_created)
        self.assertTrue(other_created)
        self.assertEqual(first.event_id, repeated.event_id)
        self.assertNotEqual(first.event_id, other.event_id)
        self.assertEqual([event.resource_id for event in replay], ["dataset-live"])

    def test_expired_events_are_not_replayed_and_cleanup_is_bounded(self) -> None:
        event, _created = self.append("event-expired")
        model = self.repository.by_idempotency_key("event-expired")
        self.assertIsNotNone(model)
        model.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        self.db.commit()

        self.assertEqual(self.repository.cursor_bounds(), (0, 0))
        self.assertEqual(
            self.repository.replay(
                after_cursor=0,
                resources={("dataset", "dataset-live")},
                limit=10,
            ),
            [],
        )
        self.assertEqual(self.repository.cleanup_expired(), 1)
        self.db.commit()
        self.assertIsNone(self.repository.by_idempotency_key("event-expired"))
        self.assertGreater(event.event_id, 0)

    def test_replay_filters_dashboard_and_dataset_resources_together(self) -> None:
        dataset_event, _created = self.append("dataset-event")
        dashboard_event, dashboard_created = self.repository.append(
            event_type="dashboard.published",
            resource_type="dashboard",
            resource_id="dashboard-live",
            aggregate_revision=2,
            correlation_id="published-revision-2",
            idempotency_key="dashboard:dashboard-live:published:2",
            invalidations=["dashboard:dashboard-live:published"],
            payload={"publishedRevisionId": "published-revision-2"},
        )
        self.append("other-dataset-event", dataset_id="dataset-other")
        self.db.commit()

        replay = self.repository.replay(
            after_cursor=0,
            resources={
                ("dashboard", "dashboard-live"),
                ("dataset", "dataset-live"),
            },
            limit=10,
        )

        self.assertTrue(dashboard_created)
        self.assertEqual(
            [event.event_id for event in replay],
            [dataset_event.event_id, dashboard_event.event_id],
        )

    def test_dataset_revision_and_event_rollback_together(self) -> None:
        live_repository = DashboardLiveRepository(self.db)
        with (
            patch(
                "app.repositories.dashboard_live_repository.settings.realtime_events_enabled",
                True,
            ),
            patch.object(
                RealtimeEventRepository,
                "append",
                side_effect=RuntimeError("event insert failed"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "event insert failed"):
                live_repository.record_dataset_commit(
                    dataset_id="dataset-atomic",
                    run_id="run-atomic",
                    storage_location="s3a://lake/run-atomic",
                    storage_format="parquet",
                    materialization_mode="delta",
                    row_count=1,
                    next_check_after_ms=1_000,
                )
            self.db.rollback()

        with Session(self.engine) as verification_db:
            verification = DashboardLiveRepository(verification_db)
            self.assertIsNone(verification.get_freshness("dataset-atomic"))
            self.assertIsNone(verification.commit_by_run_id("run-atomic"))

    def test_dataset_revision_produces_small_versioned_event(self) -> None:
        live_repository = DashboardLiveRepository(self.db)
        with patch(
            "app.repositories.dashboard_live_repository.settings.realtime_events_enabled",
            True,
        ):
            commit, created = live_repository.record_dataset_commit(
                dataset_id="dataset-event",
                run_id="run-event",
                storage_location="s3a://lake/run-event",
                storage_format="parquet",
                materialization_mode="delta",
                row_count=1,
                next_check_after_ms=1_000,
            )
            self.db.commit()

        events = self.repository.replay(
            after_cursor=0,
            resources={("dataset", "dataset-event")},
            limit=10,
        )
        self.assertTrue(created)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].aggregate_revision, commit.revision)
        self.assertEqual(events[0].payload["runId"], "run-event")
        self.assertNotIn("storageLocation", events[0].payload)


class RealtimeEventContractTests(unittest.TestCase):
    def test_unknown_event_and_secret_like_payload_are_rejected(self) -> None:
        common = {
            "resource_type": "dataset",
            "resource_id": "dataset-live",
            "aggregate_revision": 1,
            "correlation_id": "run-1",
            "invalidations": ["dataset:dataset-live:freshness"],
        }
        with self.assertRaisesRegex(ValueError, "Unsupported realtime event type"):
            validate_realtime_event(
                event_type="dataset.unknown",
                payload={},
                **common,
            )
        with self.assertRaisesRegex(ValueError, "secret-like field"):
            validate_realtime_event(
                event_type="dataset.revision.committed",
                payload={"runId": "run-1", "commitKind": {"accessToken": "nope"}},
                **common,
            )


class RealtimeEventHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_resource_filter_and_connection_limit(self) -> None:
        hub = RealtimeEventHub()
        with patch.object(settings, "realtime_connection_limit_per_actor", 1):
            subscription = hub.subscribe(
                actor_key="actor-a",
                resources={("dataset", "dataset-live")},
            )
            with self.assertRaises(RealtimeConnectionLimitError):
                hub.subscribe(
                    actor_key="actor-a",
                    resources={("dataset", "dataset-live")},
                )

        hub.publish(event_envelope(1, dataset_id="dataset-other"))
        self.assertTrue(subscription.queue.empty())
        hub.publish(event_envelope(2))
        received = await asyncio.wait_for(subscription.get(), timeout=1)
        self.assertIsInstance(received, RealtimeEventEnvelope)
        self.assertEqual(received.event_id, 2)
        self.assertEqual(hub.capacity_snapshot(), {
            "activeConnections": 1,
            "queuedEvents": 0,
            "maxSubscriberQueueDepth": 0,
        })
        subscription.close()
        self.assertEqual(hub.active_connections(), 0)

    async def test_slow_subscriber_receives_explicit_overflow(self) -> None:
        hub = RealtimeEventHub()
        with patch.object(settings, "realtime_subscriber_queue_size", 8):
            subscription = hub.subscribe(
                actor_key="actor-a",
                resources={("dataset", "dataset-live")},
            )
            for cursor in range(1, 10):
                hub.publish(event_envelope(cursor))

        item = await asyncio.wait_for(subscription.get(), timeout=1)
        self.assertIsInstance(item, RealtimeQueueOverflow)
        subscription.close()

    async def test_expired_cursor_emits_resync_and_closes_subscription(self) -> None:
        hub = RealtimeEventHub()
        subscription = hub.subscribe(
            actor_key="actor-a",
            resources={("dataset", "dataset-live")},
        )
        identity = StreamIdentity(
            actor=ActorContext(name="actor-a"),
            actor_key="actor-a",
            session_token=None,
            actor_name_header="actor-a",
            actor_role_header="viewer",
            actor_groups_header=None,
        )
        request = SimpleNamespace(is_disconnected=lambda: asyncio.sleep(0, result=False))
        snapshot = ReplaySnapshot(min_cursor=5, max_cursor=7, events=[])

        with patch("app.api.realtime._load_replay_snapshot", return_value=snapshot):
            frames = [
                frame
                async for frame in _event_stream(
                    request=request,
                    subscription=subscription,
                    identity=identity,
                    dashboard_id="dashboard-live",
                    dataset_ids={"dataset-live"},
                    initial_cursor=1,
                )
            ]

        self.assertEqual([frame["event"] for frame in frames], [
            "stream.ready",
            "system.resync_required",
        ])
        self.assertTrue(subscription.closed)

    async def test_snapshot_replay_then_live_queue_closes_the_connection_race(self) -> None:
        hub = RealtimeEventHub()
        subscription = hub.subscribe(
            actor_key="actor-a",
            resources={("dataset", "dataset-live")},
        )
        hub.publish(event_envelope(3))
        identity = StreamIdentity(
            actor=ActorContext(name="actor-a"),
            actor_key="actor-a",
            session_token=None,
            actor_name_header="actor-a",
            actor_role_header="viewer",
            actor_groups_header=None,
        )

        class DisconnectAfterLiveEvent:
            checks = 0

            async def is_disconnected(self) -> bool:
                self.checks += 1
                return self.checks > 1

        snapshot = ReplaySnapshot(
            min_cursor=1,
            max_cursor=2,
            events=[event_envelope(1), event_envelope(2)],
        )
        with patch("app.api.realtime._load_replay_snapshot", return_value=snapshot):
            frames = [
                frame
                async for frame in _event_stream(
                    request=DisconnectAfterLiveEvent(),
                    subscription=subscription,
                    identity=identity,
                    dashboard_id="dashboard-live",
                    dataset_ids={"dataset-live"},
                    initial_cursor=0,
                )
            ]

        self.assertEqual([frame["event"] for frame in frames], [
            "stream.ready",
            "dataset.revision.committed",
            "dataset.revision.committed",
            "dataset.revision.committed",
        ])
        self.assertEqual([frame.get("id") for frame in frames[1:]], ["1", "2", "3"])
        self.assertTrue(subscription.closed)

    def test_domain_frame_preserves_utf8_in_small_json_payload(self) -> None:
        event = event_envelope(1)
        event.payload["commitKind"] = "증분"

        frame = _domain_event(event)

        self.assertEqual(frame["id"], "1")
        self.assertIn("증분", frame["data"])

    async def test_dispatcher_catches_up_from_event_log_without_notify(self) -> None:
        hub = RealtimeEventHub()
        subscription = hub.subscribe(
            actor_key="actor-a",
            resources={("dataset", "dataset-live")},
        )
        dispatcher = RealtimeEventDispatcher(hub)
        dispatcher._last_cursor = 0

        with patch.object(
            dispatcher,
            "_load_after",
            side_effect=[[event_envelope(1)], []],
        ) as load_after:
            await dispatcher._dispatch_available()

        received = await asyncio.wait_for(subscription.get(), timeout=1)
        self.assertEqual(received.event_id, 1)
        self.assertEqual(dispatcher.last_cursor, 1)
        self.assertGreaterEqual(load_after.call_count, 1)
        subscription.close()

    async def test_dispatcher_recovers_after_transient_cursor_read_failure(self) -> None:
        dispatcher = RealtimeEventDispatcher(RealtimeEventHub())
        with (
            patch.object(
                dispatcher,
                "_current_cursor",
                side_effect=[RuntimeError("database unavailable"), 0],
            ) as current_cursor,
            patch.object(dispatcher, "_dispatch_available", new=AsyncMock()),
            patch("app.services.realtime_event_service._is_postgres_database", return_value=False),
            patch.object(settings, "realtime_dispatch_poll_seconds", 0.1),
        ):
            task = asyncio.create_task(dispatcher.run())
            try:
                for _attempt in range(80):
                    if dispatcher.ready:
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(dispatcher.ready)
                self.assertEqual(current_cursor.call_count, 2)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task


if __name__ == "__main__":
    unittest.main()
