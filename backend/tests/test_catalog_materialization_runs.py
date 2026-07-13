import os
import threading
import time
import unittest
from copy import deepcopy
from queue import Queue
from unittest.mock import Mock, patch
from uuid import uuid4

from sqlalchemy import create_engine, delete, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.core.materialization import materialization_mode
from app.models.catalog import CatalogDatasetModel
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.services.catalog_service import (
    CatalogService,
    recalculate_dataset_payload_from_runs,
    validate_materialization_run_delete,
)


def materialization_run(
    run_id: str,
    *,
    created_at: str,
    mode: str,
    row_count: int,
    status: str = "success",
) -> dict[str, object]:
    return {
        "createdAt": created_at,
        "jobId": "job-lock-test",
        "materializationMode": mode,
        "rowCount": row_count,
        "runId": run_id,
        "sourceKind": "etl",
        "sourceLabel": run_id,
        "status": status,
        "storageFormat": "parquet",
        "storageLocation": f"s3a://asklake-output/{run_id}/",
        "storageSizeBytes": row_count * 10,
    }


def catalog_payload(
    dataset_id: str,
    runs: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "description": "Catalog locking regression fixture",
        "downstream": [],
        "freshness": "latest",
        "id": dataset_id,
        "layer": "BRONZE",
        "lastUpdated": str(runs[0]["createdAt"]),
        "materializationRuns": runs,
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": "catalog-owner",
        "quality": "verified",
        "rag": False,
        "rows": "0 rows",
        "sampleRows": [],
        "schema": [],
        "size": "0B",
        "source": "locking-test",
        "status": "available",
        "tags": [],
        "upstream": [],
    }


class CatalogMaterializationDeleteGuardTests(unittest.TestCase):
    def test_materialization_mode_uses_explicit_mode_then_kafka_fallback(self) -> None:
        cases = [
            (
                "explicit snapshot overrides Kafka",
                {"materializationMode": " snapshot ", "sourceKind": "kafka"},
                "snapshot",
            ),
            (
                "explicit delta overrides non-Kafka",
                {"materializationMode": "DELTA", "sourceKind": "etl"},
                "delta",
            ),
            (
                "snake-case explicit delta",
                {"materialization_mode": "delta", "source_kind": "sql"},
                "delta",
            ),
            ("legacy camel-case Kafka", {"sourceKind": "kafka"}, "delta"),
            ("legacy snake-case Kafka", {"source_kind": "KAFKA"}, "delta"),
            (
                "blank mode uses Kafka fallback",
                {"materializationMode": " ", "sourceKind": "kafka"},
                "delta",
            ),
            ("missing mode for ETL", {"sourceKind": "etl"}, "snapshot"),
            ("missing mode for SQL", {"source_kind": "sql"}, "snapshot"),
            ("missing mode and source kind", {}, "snapshot"),
            (
                "invalid explicit mode does not use Kafka fallback",
                {"materializationMode": "append", "sourceKind": "kafka"},
                "snapshot",
            ),
            (
                "blank camel-case mode does not mask snake-case delta",
                {"materializationMode": " ", "materialization_mode": "delta", "sourceKind": "etl"},
                "delta",
            ),
            (
                "blank camel-case mode does not mask spark snapshot",
                {"materializationMode": " ", "spark_materialization_mode": "snapshot", "sourceKind": "kafka"},
                "snapshot",
            ),
        ]

        for label, run, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(materialization_mode(run), expected)

    def test_rebaseline_aggregate_uses_latest_snapshot_and_newer_deltas_only(self) -> None:
        runs = [
            materialization_run("delta-new", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2),
            materialization_run("snapshot", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
            materialization_run("snapshot-old", created_at="2026-07-12T01:00:00Z", mode="snapshot", row_count=20),
        ]

        payload = recalculate_dataset_payload_from_runs(catalog_payload("dataset-rebaseline", runs))

        self.assertEqual(payload["rows"], "12 rows")
        self.assertEqual(payload["size"], "120B")
        self.assertEqual(payload["sourceRunId"], "delta-new")

    def test_catalog_response_preserves_materialization_mode(self) -> None:
        payload = catalog_payload("dataset-mode", [
            materialization_run("delta-new", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2),
        ])

        response = CatalogDatasetResponse.model_validate(payload).model_dump(by_alias=True)

        self.assertEqual(response["materializationRuns"][0]["materializationMode"], "delta")

    def test_legacy_kafka_without_mode_and_previous_snapshot_are_aggregated(self) -> None:
        for source_kind_field in ("sourceKind", "source_kind"):
            with self.subTest(source_kind_field=source_kind_field):
                kafka_delta = materialization_run(
                    "kafka-delta",
                    created_at="2026-07-12T03:00:00Z",
                    mode="delta",
                    row_count=2,
                )
                kafka_delta.pop("materializationMode")
                kafka_delta.pop("sourceKind")
                kafka_delta[source_kind_field] = "kafka"
                runs = [
                    kafka_delta,
                    materialization_run(
                        "snapshot",
                        created_at="2026-07-12T02:00:00Z",
                        mode="snapshot",
                        row_count=10,
                    ),
                ]

                payload = recalculate_dataset_payload_from_runs(
                    catalog_payload(f"dataset-{source_kind_field}", runs)
                )

                self.assertEqual(payload["rows"], "12 rows")
                self.assertEqual(payload["size"], "120B")
                self.assertEqual(payload["storageSizeBytes"], 120)
                self.assertEqual(payload["sourceRunId"], "kafka-delta")

    def test_legacy_kafka_without_mode_blocks_base_snapshot_delete(self) -> None:
        for source_kind_field in ("sourceKind", "source_kind"):
            with self.subTest(source_kind_field=source_kind_field):
                kafka_delta = materialization_run(
                    "kafka-delta",
                    created_at="2026-07-12T03:00:00Z",
                    mode="delta",
                    row_count=2,
                )
                kafka_delta.pop("materializationMode")
                kafka_delta.pop("sourceKind")
                kafka_delta[source_kind_field] = "kafka"
                runs = [
                    kafka_delta,
                    materialization_run(
                        "snapshot",
                        created_at="2026-07-12T02:00:00Z",
                        mode="snapshot",
                        row_count=10,
                    ),
                ]

                with self.assertRaises(ApiError) as raised:
                    validate_materialization_run_delete(runs, "snapshot")

                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(
                    raised.exception.details["dependentDeltaRunIds"],
                    ["kafka-delta"],
                )

    def test_explicit_kafka_snapshot_overrides_source_kind_fallback(self) -> None:
        for source_kind_field in ("sourceKind", "source_kind"):
            with self.subTest(source_kind_field=source_kind_field):
                kafka_snapshot = materialization_run(
                    "kafka-snapshot",
                    created_at="2026-07-12T03:00:00Z",
                    mode="snapshot",
                    row_count=3,
                )
                kafka_snapshot.pop("sourceKind")
                kafka_snapshot[source_kind_field] = "kafka"
                runs = [
                    kafka_snapshot,
                    materialization_run(
                        "snapshot-old",
                        created_at="2026-07-12T02:00:00Z",
                        mode="snapshot",
                        row_count=10,
                    ),
                ]

                payload = recalculate_dataset_payload_from_runs(
                    catalog_payload(f"dataset-explicit-{source_kind_field}", runs)
                )

                self.assertEqual(payload["rows"], "3 rows")
                self.assertEqual(payload["size"], "30B")
                self.assertEqual(payload["storageSizeBytes"], 30)
                self.assertEqual(payload["sourceRunId"], "kafka-snapshot")

    def test_active_snapshot_cannot_be_deleted_before_newer_deltas(self) -> None:
        runs = [
            materialization_run("delta-new", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2),
            materialization_run("snapshot", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
            materialization_run("snapshot-old", created_at="2026-07-12T01:00:00Z", mode="snapshot", row_count=20),
        ]

        with self.assertRaises(ApiError) as raised:
            validate_materialization_run_delete(runs, "snapshot")

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details["dependentDeltaRunIds"], ["delta-new"])

    def test_inactive_snapshot_can_be_deleted(self) -> None:
        validate_materialization_run_delete([
            materialization_run("snapshot-new", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
            materialization_run("snapshot-old", created_at="2026-07-12T01:00:00Z", mode="snapshot", row_count=20),
        ], "snapshot-old")

    def test_failed_delta_does_not_block_snapshot_delete(self) -> None:
        validate_materialization_run_delete([
            materialization_run("delta-failed", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2, status="failed"),
            materialization_run("snapshot", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
        ], "snapshot")


class CatalogMaterializationLockingTests(unittest.TestCase):
    def test_repository_lock_path_compiles_select_for_update(self) -> None:
        db = Mock()
        db.scalar.return_value = None
        repository = CatalogRepository(db)

        with patch("app.repositories.catalog_repository.ensure_catalog_schema"):
            result = repository.get_dataset_payload_for_update("dataset-lock-test")

        self.assertIsNone(result)
        statement = db.scalar.call_args.args[0]
        compiled_sql = str(statement.compile(dialect=postgresql.dialect()))
        self.assertIn("FOR UPDATE", compiled_sql.upper())
        self.assertIn("catalog_datasets.id", compiled_sql)

    def test_delete_preserves_delta_from_locked_payload(self) -> None:
        locked_runs = [
            materialization_run("delta-concurrent", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2),
            materialization_run("snapshot-current", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
            materialization_run("snapshot-old", created_at="2026-07-12T01:00:00Z", mode="snapshot", row_count=20),
        ]

        class RaceAwareRepository:
            db = object()

            def __init__(self) -> None:
                self.calls: list[str] = []
                self.saved_payload: dict[str, object] | None = None

            def get_dataset_payload(self, dataset_id: str) -> dict[str, object]:
                raise AssertionError("delete must not compute from an unlocked payload")

            def get_dataset_payload_for_update(self, dataset_id: str) -> dict[str, object]:
                self.calls.append("lock")
                return deepcopy(catalog_payload(dataset_id, locked_runs))

            def save_dataset_payload(self, payload: dict[str, object]) -> dict[str, object]:
                self.calls.append("save")
                self.saved_payload = deepcopy(payload)
                return payload

        repository = RaceAwareRepository()
        service = CatalogService(None, repository, None)  # type: ignore[arg-type]
        actor = ActorContext(name="catalog-owner", role="viewer")

        with (
            patch(
                "app.services.catalog_service.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch("app.services.catalog_service.require_governed_access"),
            patch(
                "app.services.catalog_service.with_dataset_permissions",
                side_effect=lambda dataset, _actor, _db=None: dataset,
            ),
        ):
            response = service.delete_materialization_run(
                "dataset-lock-test",
                "snapshot-old",
                actor,
            )

        self.assertEqual(repository.calls, ["lock", "save"])
        self.assertIsNotNone(repository.saved_payload)
        saved_runs = repository.saved_payload["materializationRuns"]  # type: ignore[index]
        self.assertEqual(
            [run["runId"] for run in saved_runs],  # type: ignore[index]
            ["delta-concurrent", "snapshot-current"],
        )
        self.assertEqual(response.deleted_run_id, "snapshot-old")
        self.assertEqual(response.dataset.rows, "12 rows")

    def test_locked_legacy_kafka_delta_still_blocks_active_snapshot_delete(self) -> None:
        kafka_delta = materialization_run(
            "kafka-concurrent",
            created_at="2026-07-12T03:00:00Z",
            mode="delta",
            row_count=2,
        )
        kafka_delta.pop("materializationMode")
        kafka_delta["sourceKind"] = "kafka"
        locked_runs = [
            kafka_delta,
            materialization_run("snapshot-current", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
        ]

        class ActiveSnapshotRepository:
            db = object()
            saved = False

            def get_dataset_payload_for_update(self, dataset_id: str) -> dict[str, object]:
                return deepcopy(catalog_payload(dataset_id, locked_runs))

            def save_dataset_payload(self, payload: dict[str, object]) -> dict[str, object]:
                self.saved = True
                return payload

        repository = ActiveSnapshotRepository()
        service = CatalogService(None, repository, None)  # type: ignore[arg-type]

        with (
            patch(
                "app.services.catalog_service.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch("app.services.catalog_service.require_governed_access"),
        ):
            with self.assertRaises(ApiError) as raised:
                service.delete_materialization_run(
                    "dataset-lock-test",
                    "snapshot-current",
                    ActorContext(name="catalog-owner", role="viewer"),
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            raised.exception.details["dependentDeltaRunIds"],
            ["kafka-concurrent"],
        )
        self.assertFalse(repository.saved)

    def test_locked_delete_still_enforces_manage_or_delete_permission(self) -> None:
        locked_runs = [
            materialization_run("snapshot-current", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10),
        ]

        class PermissionRepository:
            db = object()
            saved = False

            def get_dataset_payload_for_update(self, dataset_id: str) -> dict[str, object]:
                return deepcopy(catalog_payload(dataset_id, locked_runs))

            def save_dataset_payload(self, payload: dict[str, object]) -> dict[str, object]:
                self.saved = True
                return payload

        repository = PermissionRepository()
        service = CatalogService(None, repository, None)  # type: ignore[arg-type]

        with (
            patch(
                "app.services.catalog_service.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch("app.services.catalog_service.require_governed_access"),
            patch("app.services.catalog_service.record_forbidden_dataset_event") as audit_forbidden,
        ):
            with self.assertRaises(ApiError) as raised:
                service.delete_materialization_run(
                    "dataset-lock-test",
                    "snapshot-current",
                    ActorContext(name="catalog-viewer", role="viewer"),
                )

        self.assertEqual(raised.exception.status_code, 403)
        audit_forbidden.assert_called_once()
        self.assertFalse(repository.saved)


@unittest.skipUnless(
    os.getenv("ASKLAKE_TEST_POSTGRES_CONCURRENCY") == "1",
    "set ASKLAKE_TEST_POSTGRES_CONCURRENCY=1 to run the PostgreSQL lock test",
)
class CatalogMaterializationPostgresConcurrencyTests(unittest.TestCase):
    """Catalog snapshot/delta lock coverage; Kafka runtimes are tested elsewhere."""

    def test_delete_waits_for_append_lock_and_preserves_committed_delta(self) -> None:
        engine = create_engine(settings.database_url, pool_pre_ping=True)
        if engine.dialect.name != "postgresql":
            engine.dispose()
            self.skipTest("PostgreSQL is required for row-lock serialization")

        session_factory = sessionmaker(bind=engine, expire_on_commit=False)
        dataset_id = f"ds_catalog_lock_{uuid4().hex}"
        append_locked = threading.Event()
        release_append = threading.Event()
        delete_pid_ready = threading.Event()
        delete_lock_acquired = threading.Event()
        errors: Queue = Queue()
        delete_backend_pid: list[int] = []
        delete_observed_run_ids: list[str] = []
        threads: list[threading.Thread] = []

        snapshot_current = materialization_run(
            "snapshot-current", created_at="2026-07-12T02:00:00Z", mode="snapshot", row_count=10,
        )
        snapshot_old = materialization_run(
            "snapshot-old", created_at="2026-07-12T01:00:00Z", mode="snapshot", row_count=20,
        )
        concurrent_delta = materialization_run(
            "delta-concurrent", created_at="2026-07-12T03:00:00Z", mode="delta", row_count=2,
        )
        for run in (snapshot_current, snapshot_old, concurrent_delta):
            run["sourceKind"] = "etl"

        def append_worker() -> None:
            try:
                with session_factory() as db:
                    repository = CatalogRepository(db)
                    payload = repository.get_dataset_payload_for_update(dataset_id)
                    if payload is None:
                        raise AssertionError("append worker could not load the dataset")
                    append_locked.set()
                    if not release_append.wait(timeout=10):
                        raise TimeoutError("append worker was not released")
                    payload["materializationRuns"] = [
                        concurrent_delta,
                        *payload["materializationRuns"],
                    ]
                    repository.save_dataset_payload(payload)
            except BaseException as exc:
                errors.put(exc)
                append_locked.set()

        def delete_worker() -> None:
            try:
                if not append_locked.wait(timeout=10):
                    raise TimeoutError("append worker did not acquire its row lock")
                with session_factory() as db:
                    backend_pid = db.scalar(text("SELECT pg_backend_pid()"))
                    delete_backend_pid.append(int(backend_pid))
                    delete_pid_ready.set()
                    repository = CatalogRepository(db)
                    payload = repository.get_dataset_payload_for_update(dataset_id)
                    delete_lock_acquired.set()
                    if payload is None:
                        raise AssertionError("delete worker could not load the dataset")
                    runs = payload["materializationRuns"]
                    delete_observed_run_ids.extend(
                        str(run.get("runId"))
                        for run in runs
                        if isinstance(run, dict)
                    )
                    next_runs = [
                        run
                        for run in runs
                        if isinstance(run, dict) and run.get("runId") != "snapshot-old"
                    ]
                    repository.save_dataset_payload(
                        recalculate_dataset_payload_from_runs({
                            **payload,
                            "materializationRuns": next_runs,
                        })
                    )
            except BaseException as exc:
                errors.put(exc)
                delete_pid_ready.set()

        try:
            with session_factory() as db:
                CatalogRepository(db).save_dataset_payload(
                    catalog_payload(dataset_id, [snapshot_current, snapshot_old])
                )

            append_thread = threading.Thread(target=append_worker, name="catalog-append-lock-test")
            delete_thread = threading.Thread(target=delete_worker, name="catalog-delete-lock-test")
            threads.extend([append_thread, delete_thread])
            append_thread.start()
            self.assertTrue(append_locked.wait(timeout=10))
            delete_thread.start()
            self.assertTrue(delete_pid_ready.wait(timeout=10))
            if not errors.empty():
                raise errors.get()
            self.assertEqual(len(delete_backend_pid), 1)

            blocked_on_row_lock = False
            deadline = time.monotonic() + 5
            with engine.connect() as connection:
                while time.monotonic() < deadline and not delete_lock_acquired.is_set():
                    wait_event_type = connection.scalar(
                        text(
                            "SELECT wait_event_type FROM pg_stat_activity "
                            "WHERE pid = :backend_pid"
                        ),
                        {"backend_pid": delete_backend_pid[0]},
                    )
                    if wait_event_type == "Lock":
                        blocked_on_row_lock = True
                        break
                    time.sleep(0.05)

            self.assertTrue(blocked_on_row_lock, "delete did not block on the append transaction's row lock")
            self.assertFalse(delete_lock_acquired.is_set())
            release_append.set()

            for thread in threads:
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive(), f"{thread.name} did not finish")
            if not errors.empty():
                raise errors.get()

            self.assertTrue(delete_lock_acquired.is_set())
            self.assertEqual(
                delete_observed_run_ids,
                ["delta-concurrent", "snapshot-current", "snapshot-old"],
            )
            with session_factory() as db:
                final_payload = CatalogRepository(db).get_dataset_payload(dataset_id)
            self.assertIsNotNone(final_payload)
            self.assertEqual(
                [run["runId"] for run in final_payload["materializationRuns"]],  # type: ignore[index]
                ["delta-concurrent", "snapshot-current"],
            )
            self.assertEqual(final_payload["rows"], "12 rows")  # type: ignore[index]
        finally:
            release_append.set()
            for thread in threads:
                thread.join(timeout=10)
            try:
                with session_factory() as db:
                    db.execute(
                        delete(CatalogDatasetModel).where(CatalogDatasetModel.id == dataset_id)
                    )
                    db.commit()
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
