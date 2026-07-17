from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.api.dashboard_live import query_dataset_freshness
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.dashboard import (
    DashboardRuntimeWidgetType,
    DatasetFreshnessQueryRequest,
    DatasetFreshnessResponse,
)
from app.services.dashboard_physical_data import (
    DashboardDatasetQuerySession,
    DashboardRemoteScanBudget,
    dashboard_result_from_aggregate_state,
    merge_dashboard_aggregate_states,
)
from app.services.dashboard_runtime_service import DashboardRuntimeService


def dataset_payload(dataset_id: str = "dataset-live") -> dict[str, object]:
    return {
        "description": "Live dashboard test dataset",
        "freshness": "latest",
        "id": dataset_id,
        "lastUpdated": "2026-07-14T00:00:00Z",
        "layer": "GOLD",
        "materializationRuns": [],
        "name": dataset_id,
        "nextRefresh": "-",
        "owner": "data-team-01",
        "permissionGrants": [{
            "actions": ["query", "view"],
            "principalId": "dashboard-viewer",
            "principalType": "user",
        }],
        "quality": "passed",
        "rag": False,
        "rows": "0",
        "sampleRows": [],
        "schema": [["category", "string"], ["amount", "double"]],
        "size": "0 B",
        "source": "Kafka",
        "status": "available",
        "storageFormat": "parquet",
        "storageLocation": "s3a://asklake-output/live/_batches",
        "tags": ["live"],
    }


def widget_config(aggregation: str = "sum") -> dict[str, object]:
    return {
        "aggregation": aggregation,
        "color": {"colors": ["#2563eb"]},
        "xKey": "category",
        "yKey": "amount",
    }


def runtime_widget(config: dict[str, object] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        config=config or widget_config(),
        data=[],
        dataset_id="dataset-live",
        id="widget-live",
        layout={"x": 0, "y": 0, "w": 4, "h": 3},
        page_id="page-live",
        query_id=None,
        title="Live orders",
        type="bar_chart",
    )


def aggregate_state(
    rows: list[dict[str, object]],
    *,
    aggregation: str = "sum",
) -> dict[str, object]:
    return {
        "version": 1,
        "widgetType": "bar_chart",
        "aggregation": aggregation,
        "dimensionKeys": ["category"],
        "valueConfigKey": "yKey",
        "valueAlias": "amount" if aggregation != "count" else "__asklake_widget_value",
        "sourceConfig": widget_config(aggregation),
        "rows": rows,
    }


class FakeDb:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0
        self.events: list[str] = []

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeCatalogRepository:
    def __init__(self, db: FakeDb) -> None:
        self.db = db
        self.payload = dataset_payload()
        self.calls: list[str] = []

    def get_dataset_payload(self, dataset_id: str):
        return self.payload if dataset_id == self.payload["id"] else None

    def get_dataset_payload_for_update(self, dataset_id: str):
        self.calls.append("catalog")
        self.db.events.append("catalog")
        return self.get_dataset_payload(dataset_id)


class FakeLiveRepository:
    def __init__(
        self,
        *,
        latest_revision: int,
        saved_result: SimpleNamespace | None,
        commits: list[SimpleNamespace] | None = None,
        previous_result: SimpleNamespace | None = None,
    ) -> None:
        self.db = FakeDb()
        self.latest_revision = latest_revision
        self.saved_result = saved_result
        self.previous_result = previous_result
        self.commits = commits or []
        self.save_calls: list[dict[str, object]] = []
        self.calls: list[str] = []
        self.latest_result_dataset_ids: list[str] = []

    def continuous_job_by_dataset(self, _dataset_id: str):
        return SimpleNamespace(execution_mode="continuous")

    def get_freshness(self, _dataset_id: str, *, for_update: bool = False):
        self.calls.append("freshness_locked" if for_update else "freshness")
        self.db.events.append("freshness_locked" if for_update else "freshness")
        return SimpleNamespace(latest_revision=self.latest_revision)

    def get_widget_result(self, _widget_id: str, _calculation_version: str, *, for_update: bool = False):
        return self.saved_result

    def latest_widget_result(self, _widget_id: str, dataset_id: str):
        self.latest_result_dataset_ids.append(dataset_id)
        if self.previous_result is None:
            return None
        return self.previous_result if self.previous_result.dataset_id == dataset_id else None

    def list_commits(self, _dataset_id: str, *, after_revision: int, through_revision: int):
        return [
            commit
            for commit in self.commits
            if after_revision < commit.revision <= through_revision
        ]

    def save_widget_result(self, **values):
        self.save_calls.append(values)
        return SimpleNamespace(calculated_at=datetime(2026, 7, 14, 1, 2, 3, tzinfo=UTC))


def render_live_widget(
    service: DashboardRuntimeService,
    widget: SimpleNamespace | None = None,
):
    return service._widget_to_schema(
        widget or runtime_widget(),
        {},
        {},
        {},
        {},
        actor=ActorContext(name="dashboard-viewer", role="viewer"),
        remote_budget=DashboardRemoteScanBudget(max_bytes=1024 * 1024, max_objects=32),
        api_path="/api/dashboards/dashboard-live/widgets/query",
        http_method="POST",
    )


class DashboardAggregateStateTests(unittest.TestCase):
    def test_count_sum_and_average_delta_merge_match_full_materialization(self) -> None:
        with TemporaryDirectory() as temp_dir:
            base_path = Path(temp_dir) / "base.csv"
            delta_path = Path(temp_dir) / "delta.csv"
            base_path.write_text(
                "category,amount\nA,10\nA,20\nB,5\n",
                encoding="utf-8",
            )
            delta_path.write_text(
                "category,amount\nA,30\nB,15\nC,8\nC,12\n",
                encoding="utf-8",
            )
            base_dataset = {
                "id": "dataset-live",
                "storageFormat": "csv",
                "storageLocation": str(base_path),
            }
            delta_dataset = {
                "id": "dataset-live",
                "storageFormat": "csv",
                "storageLocation": str(delta_path),
            }
            full_dataset = {
                "id": "dataset-live",
                "storageFormat": "csv",
                "materializationRuns": [
                    {
                        "materializationMode": "delta",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(delta_path),
                    },
                    {
                        "materializationMode": "snapshot",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(base_path),
                    },
                ],
            }

            for aggregation in ("count", "sum", "avg"):
                with self.subTest(aggregation=aggregation):
                    config = widget_config(aggregation)
                    base_session = DashboardDatasetQuerySession(base_dataset)
                    delta_session = DashboardDatasetQuerySession(delta_dataset)
                    full_session = DashboardDatasetQuerySession(full_dataset)
                    try:
                        base_state = base_session.read_aggregate_state("bar_chart", config)
                        delta_state = delta_session.read_aggregate_state("bar_chart", config)
                        full_state = full_session.read_aggregate_state("bar_chart", config)
                    finally:
                        base_session.close()
                        delta_session.close()
                        full_session.close()

                    self.assertIsNotNone(base_state)
                    self.assertIsNotNone(delta_state)
                    self.assertIsNotNone(full_state)
                    merged_state = merge_dashboard_aggregate_states(base_state, delta_state)
                    self.assertIsNotNone(merged_state)

                    merged_result = dashboard_result_from_aggregate_state(merged_state)
                    full_result = dashboard_result_from_aggregate_state(full_state)
                    value_key = merged_result["config"]["yKey"]
                    merged_values = {
                        row["category"]: row[value_key]
                        for row in merged_result["data"]
                    }
                    full_values = {
                        row["category"]: row[value_key]
                        for row in full_result["data"]
                    }
                    self.assertEqual(merged_values, full_values)

            self.assertEqual(
                {
                    row["category"]: row["amount"]
                    for row in dashboard_result_from_aggregate_state(full_state)["data"]
                },
                {"A": 20.0, "B": 10.0, "C": 10.0},
            )

    def test_incompatible_calculation_states_do_not_merge(self) -> None:
        current = aggregate_state([], aggregation="sum")
        delta = aggregate_state([], aggregation="avg")

        self.assertIsNone(merge_dashboard_aggregate_states(current, delta))


class DashboardLiveRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.permission_patches = (
            patch(
                "app.services.dashboard_runtime_service.dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ),
            patch(
                "app.services.dashboard_runtime_service.require_dashboard_dataset_query_access",
            ),
        )
        for permission_patch in self.permission_patches:
            permission_patch.start()

    def tearDown(self) -> None:
        for permission_patch in reversed(self.permission_patches):
            permission_patch.stop()

    def service(self, live_repository: FakeLiveRepository) -> DashboardRuntimeService:
        service = DashboardRuntimeService(
            SimpleNamespace(),
            FakeCatalogRepository(live_repository.db),
            live_repository,
        )
        return service

    def saved_result(self, *, applied_revision: int, state: dict[str, object]) -> SimpleNamespace:
        return SimpleNamespace(
            applied_revision=applied_revision,
            calculated_at=datetime(2026, 7, 14, 0, 0, tzinfo=UTC),
            calculation_state=state,
            result_payload=dashboard_result_from_aggregate_state(state),
        )

    def test_same_revision_returns_postgres_result_without_opening_physical_session(self) -> None:
        state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        live_repository = FakeLiveRepository(
            latest_revision=4,
            saved_result=self.saved_result(applied_revision=4, state=state),
        )

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            side_effect=AssertionError("physical session must not open"),
        ) as physical_session:
            response = render_live_widget(self.service(live_repository))

        physical_session.assert_not_called()
        self.assertEqual(response.applied_revision, 4)
        self.assertEqual(response.data, [{"category": "A", "amount": 30.0}])
        self.assertEqual(live_repository.db.commits, 1)
        self.assertEqual(live_repository.save_calls, [])

    def test_live_widget_locks_catalog_before_freshness_revision(self) -> None:
        state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 10.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 10.0,
        }])
        live_repository = FakeLiveRepository(
            latest_revision=1,
            saved_result=self.saved_result(applied_revision=1, state=state),
        )
        service = self.service(live_repository)
        catalog_repository = service.catalog_repository

        render_live_widget(service)

        self.assertEqual(catalog_repository.calls, ["catalog"])
        self.assertEqual(live_repository.calls[0], "freshness_locked")
        self.assertEqual(live_repository.db.events[:2], ["catalog", "freshness_locked"])

    def test_new_revision_reads_only_revision_delta_and_persists_incremental_result(self) -> None:
        current_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        delta_state = aggregate_state([
            {
                "category": "A",
                "__asklake_state_count": 1,
                "__asklake_state_sum": 5.0,
                "__asklake_state_min": 5.0,
                "__asklake_state_max": 5.0,
            },
            {
                "category": "B",
                "__asklake_state_count": 1,
                "__asklake_state_sum": 7.0,
                "__asklake_state_min": 7.0,
                "__asklake_state_max": 7.0,
            },
        ])
        commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=2,
            row_count=2,
            run_id="run-2",
            storage_format="parquet",
            storage_location="s3a://asklake-output/live/_batches/batch_id=2",
        )
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=self.saved_result(applied_revision=1, state=current_state),
            commits=[commit],
        )
        opened_payloads: list[dict[str, object]] = []

        class DeltaSession:
            def __init__(self, payload, **_kwargs) -> None:
                opened_payloads.append(payload)

            def read_aggregate_state(self, _widget_type, _config):
                return delta_state

            def close(self) -> None:
                return None

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            DeltaSession,
        ):
            response = render_live_widget(self.service(live_repository))

        self.assertEqual(len(opened_payloads), 1)
        self.assertEqual(
            [run["storageLocation"] for run in opened_payloads[0]["materializationRuns"]],
            [commit.storage_location],
        )
        self.assertEqual(response.applied_revision, 2)
        self.assertEqual(
            {row["category"]: row["amount"] for row in response.data},
            {"A": 35.0, "B": 7.0},
        )
        self.assertEqual(len(live_repository.save_calls), 1)
        self.assertEqual(live_repository.save_calls[0]["applied_revision"], 2)
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "incremental")

    def test_iceberg_revision_reads_only_rows_tagged_with_the_commit_run_id(self) -> None:
        current_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        delta_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 5.0,
            "__asklake_state_min": 5.0,
            "__asklake_state_max": 5.0,
        }])
        commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=2,
            row_count=1,
            run_id="continuous:job-live:batch:2:offsets",
            storage_format="iceberg",
            storage_location="s3://warehouse/asklake/dataset-live",
        )
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=self.saved_result(applied_revision=1, state=current_state),
            commits=[commit],
        )
        service = self.service(live_repository)
        service.catalog_repository.payload["icebergSnapshotId"] = "2002"
        requested_run_ids: list[str | None] = []
        requested_snapshot_ids: list[str | None] = []

        class IcebergDeltaSession:
            revision_delta_available = True

            def __init__(self, payload, **kwargs) -> None:
                requested_run_ids.append(kwargs.get("iceberg_run_id"))
                requested_snapshot_ids.append(payload.get("icebergSnapshotId"))

            def read_aggregate_state(self, _widget_type, _config):
                return delta_state

            def close(self) -> None:
                return None

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            IcebergDeltaSession,
        ):
            response = render_live_widget(service)

        self.assertEqual(requested_run_ids, [commit.run_id])
        self.assertEqual(requested_snapshot_ids, ["2002"])
        self.assertEqual(response.applied_revision, 2)
        self.assertEqual(response.data, [{"category": "A", "amount": 35.0}])
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "incremental")

    def test_iceberg_without_run_id_column_falls_back_to_full_recalculation(self) -> None:
        current_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        full_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 3,
            "__asklake_state_sum": 35.0,
            "__asklake_state_min": 5.0,
            "__asklake_state_max": 20.0,
        }])
        commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=2,
            row_count=1,
            run_id="continuous:job-live:batch:2:offsets",
            storage_format="iceberg",
            storage_location="s3://warehouse/asklake/dataset-live",
        )
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=self.saved_result(applied_revision=1, state=current_state),
            commits=[commit],
        )

        class IcebergWithoutRunIdSession:
            revision_delta_available = False

            def __init__(self, _payload, **_kwargs) -> None:
                return None

            def read_aggregate_state(self, _widget_type, _config):
                raise AssertionError("unsafe cumulative Iceberg data must not be merged as a delta")

            def close(self) -> None:
                return None

        service = self.service(live_repository)
        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            IcebergWithoutRunIdSession,
        ), patch.object(
            service,
            "_full_widget_result",
            return_value=(dashboard_result_from_aggregate_state(full_state), full_state),
        ) as full_calculation:
            response = render_live_widget(service)

        full_calculation.assert_called_once()
        self.assertEqual(response.applied_revision, 2)
        self.assertEqual(response.data, [{"category": "A", "amount": 35.0}])
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_nonempty_commit_with_empty_delta_falls_back_to_full_recalculation(self) -> None:
        current_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        full_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 3,
            "__asklake_state_sum": 35.0,
            "__asklake_state_min": 5.0,
            "__asklake_state_max": 20.0,
        }])
        commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=2,
            row_count=1,
            run_id="continuous:job-live:batch:2:offsets",
            storage_format="iceberg",
            storage_location="s3://warehouse/asklake/dataset-live",
        )
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=self.saved_result(applied_revision=1, state=current_state),
            commits=[commit],
        )

        class EmptyDeltaSession:
            revision_delta_available = True

            def __init__(self, _payload, **_kwargs) -> None:
                return None

            def read_aggregate_state(self, _widget_type, _config):
                return aggregate_state([])

            def close(self) -> None:
                return None

        service = self.service(live_repository)
        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            EmptyDeltaSession,
        ), patch.object(
            service,
            "_full_widget_result",
            return_value=(dashboard_result_from_aggregate_state(full_state), full_state),
        ) as full_calculation:
            response = render_live_widget(service)

        full_calculation.assert_called_once()
        self.assertEqual(response.applied_revision, 2)
        self.assertEqual(response.data, [{"category": "A", "amount": 35.0}])
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_large_revision_gap_advances_one_committed_revision_at_a_time(self) -> None:
        current_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 10.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 10.0,
        }])
        delta_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 2.0,
            "__asklake_state_min": 2.0,
            "__asklake_state_max": 2.0,
        }])
        commits = [
            SimpleNamespace(
                commit_kind="stream",
                materialization_mode="delta",
                revision=revision,
                row_count=1,
                run_id=f"run-{revision}",
                storage_format="parquet",
                storage_location=f"s3a://asklake-output/live/_batches/batch_id={revision}",
            )
            for revision in (2, 3, 4)
        ]
        live_repository = FakeLiveRepository(
            latest_revision=4,
            saved_result=self.saved_result(applied_revision=1, state=current_state),
            commits=commits,
        )
        opened_paths: list[str] = []

        class DeltaSession:
            def __init__(self, payload, **_kwargs) -> None:
                opened_paths.extend(
                    run["storageLocation"]
                    for run in payload["materializationRuns"]
                )

            def read_aggregate_state(self, _widget_type, _config):
                return delta_state

            def close(self) -> None:
                return None

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            DeltaSession,
        ):
            response = render_live_widget(self.service(live_repository))

        self.assertEqual(opened_paths, [commits[0].storage_location])
        self.assertEqual(response.applied_revision, 2)
        self.assertEqual(response.data, [{"category": "A", "amount": 12.0}])
        self.assertEqual(live_repository.save_calls[0]["applied_revision"], 2)

    def test_new_additive_widget_bootstraps_with_one_full_calculation(self) -> None:
        full_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 6,
            "__asklake_state_sum": 24.0,
            "__asklake_state_min": 3.0,
            "__asklake_state_max": 5.0,
        }])
        commits = [
            SimpleNamespace(
                commit_kind="stream",
                materialization_mode="delta",
                revision=revision,
                row_count=2,
                run_id=f"run-{revision}",
                storage_format="parquet",
                storage_location=f"s3a://asklake-output/live/_batches/batch_id={revision}",
            )
            for revision in (1, 2, 3)
        ]
        live_repository = FakeLiveRepository(
            latest_revision=3,
            saved_result=None,
            commits=commits,
        )
        service = self.service(live_repository)
        with patch.object(
            service,
            "_incremental_widget_result",
            side_effect=AssertionError("new widgets must establish a full baseline"),
        ), patch.object(
            service,
            "_full_widget_result",
            return_value=(dashboard_result_from_aggregate_state(full_state), full_state),
        ) as full_calculation:
            response = render_live_widget(service)

        full_calculation.assert_called_once()
        self.assertEqual(response.applied_revision, 3)
        self.assertEqual(response.data, [{"category": "A", "amount": 24.0}])
        self.assertEqual(live_repository.save_calls[0]["applied_revision"], 3)
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_initial_bootstrap_falls_back_when_catalog_has_unversioned_legacy_data(self) -> None:
        first_commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=1,
            row_count=1,
            run_id="run-1",
            storage_format="parquet",
            storage_location="s3a://asklake-output/live/_batches/batch_id=1",
        )
        live_repository = FakeLiveRepository(
            latest_revision=1,
            saved_result=None,
            commits=[first_commit],
        )
        service = self.service(live_repository)
        service.catalog_repository.payload["materializationRuns"] = [
            {
                "createdAt": "2026-07-14T00:00:01Z",
                "jobId": "job-live",
                "materializationMode": "delta",
                "rowCount": 1,
                "runId": "run-1",
                "sourceKind": "kafka",
                "sourceLabel": "orders",
                "status": "success",
                "storageFormat": "parquet",
                "storageLocation": first_commit.storage_location,
                "storageSizeBytes": 1,
            },
            {
                "createdAt": "2026-07-13T00:00:00Z",
                "jobId": "legacy-job",
                "materializationMode": "snapshot",
                "rowCount": 1,
                "runId": "legacy-snapshot",
                "sourceKind": "etl",
                "sourceLabel": "legacy",
                "status": "success",
                "storageFormat": "parquet",
                "storageLocation": "s3a://asklake-output/live/_snapshots/legacy",
                "storageSizeBytes": 1,
            },
        ]
        full_state = aggregate_state([{
            "category": "all",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 15.0,
            "__asklake_state_min": 5.0,
            "__asklake_state_max": 10.0,
        }])

        with patch.object(
            service,
            "_full_widget_result",
            return_value=(dashboard_result_from_aggregate_state(full_state), full_state),
        ) as full_calculation:
            response = render_live_widget(service)

        full_calculation.assert_called_once()
        self.assertEqual(response.applied_revision, 1)
        self.assertEqual(response.data, [{"category": "all", "amount": 15.0}])
        self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_backfill_and_legacy_revisions_use_full_recalculation(self) -> None:
        previous_state = aggregate_state([{
            "category": "old",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 99.0,
            "__asklake_state_min": 99.0,
            "__asklake_state_max": 99.0,
        }])
        full_state = aggregate_state([{
            "category": "current",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 7.0,
            "__asklake_state_min": 7.0,
            "__asklake_state_max": 7.0,
        }])
        for commit_kind, materialization_mode in (
            ("backfill", "snapshot"),
            ("legacy", "delta"),
        ):
            with self.subTest(commit_kind=commit_kind):
                commit = SimpleNamespace(
                    commit_kind=commit_kind,
                    materialization_mode=materialization_mode,
                    revision=2,
                    row_count=1,
                    run_id=f"{commit_kind}-2",
                    storage_format="parquet",
                    storage_location=f"s3a://asklake-output/live/{commit_kind}/run-2",
                )
                live_repository = FakeLiveRepository(
                    latest_revision=2,
                    saved_result=self.saved_result(applied_revision=1, state=previous_state),
                    commits=[commit],
                )
                service = self.service(live_repository)

                with patch.object(
                    service,
                    "_full_widget_result",
                    return_value=(dashboard_result_from_aggregate_state(full_state), full_state),
                ) as full_calculation:
                    response = render_live_widget(service)

                full_calculation.assert_called_once()
                self.assertEqual(response.applied_revision, 2)
                self.assertEqual(response.data, [{"category": "current", "amount": 7.0}])
                self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_min_and_max_use_full_recalculation_instead_of_delta_merge(self) -> None:
        for aggregation in ("min", "max"):
            with self.subTest(aggregation=aggregation):
                current_state = aggregate_state([{
                    "category": "A",
                    "__asklake_state_count": 1,
                    "__asklake_state_sum": 10.0,
                    "__asklake_state_min": 10.0,
                    "__asklake_state_max": 10.0,
                }], aggregation=aggregation)
                full_state = aggregate_state([{
                    "category": "A",
                    "__asklake_state_count": 2,
                    "__asklake_state_sum": 15.0,
                    "__asklake_state_min": 5.0,
                    "__asklake_state_max": 10.0,
                }], aggregation=aggregation)
                live_repository = FakeLiveRepository(
                    latest_revision=2,
                    saved_result=self.saved_result(applied_revision=1, state=current_state),
                    commits=[SimpleNamespace(
                        commit_kind="stream",
                        materialization_mode="delta",
                        revision=2,
                        row_count=1,
                        run_id="run-2",
                        storage_format="parquet",
                        storage_location="s3a://asklake-output/live/_batches/batch_id=2",
                    )],
                )
                service = self.service(live_repository)
                full_result = dashboard_result_from_aggregate_state(full_state)

                with patch.object(
                    service,
                    "_incremental_widget_result",
                    side_effect=AssertionError("min/max must not use incremental merge"),
                ), patch.object(
                    service,
                    "_full_widget_result",
                    return_value=(full_result, full_state),
                ) as full_calculation:
                    response = render_live_widget(
                        service,
                        runtime_widget(widget_config(aggregation)),
                    )

                full_calculation.assert_called_once()
                self.assertEqual(response.applied_revision, 2)
                self.assertEqual(live_repository.save_calls[0]["calculation_mode"], "full")

    def test_refresh_failure_keeps_the_last_saved_result_and_revision(self) -> None:
        state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        commit = SimpleNamespace(
            commit_kind="stream",
            materialization_mode="delta",
            revision=2,
            row_count=1,
            run_id="run-2",
            storage_format="parquet",
            storage_location="s3a://asklake-output/live/_batches/batch_id=2",
        )
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=self.saved_result(applied_revision=1, state=state),
            commits=[commit],
        )

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            side_effect=ValueError("temporary S3 failure"),
        ):
            response = render_live_widget(self.service(live_repository))

        self.assertEqual(response.applied_revision, 1)
        self.assertEqual(response.data, [{"category": "A", "amount": 30.0}])
        self.assertEqual(live_repository.save_calls, [])
        self.assertEqual(live_repository.db.rollbacks, 1)

    def test_new_calculation_version_failure_keeps_previous_successful_result(self) -> None:
        previous_state = aggregate_state([{
            "category": "A",
            "__asklake_state_count": 2,
            "__asklake_state_sum": 30.0,
            "__asklake_state_min": 10.0,
            "__asklake_state_max": 20.0,
        }])
        previous = self.saved_result(applied_revision=1, state=previous_state)
        previous.calculation_version = "previous-calculation-version"
        previous.dataset_id = "dataset-live"
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=None,
            previous_result=previous,
        )

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            side_effect=ValueError("temporary S3 failure"),
        ):
            response = render_live_widget(self.service(live_repository))

        self.assertEqual(response.applied_revision, 1)
        self.assertEqual(response.calculation_version, "previous-calculation-version")
        self.assertEqual(response.data, [{"category": "A", "amount": 30.0}])
        self.assertEqual(live_repository.save_calls, [])
        self.assertEqual(live_repository.latest_result_dataset_ids, ["dataset-live"])

    def test_previous_result_from_another_dataset_is_never_used_as_fallback(self) -> None:
        previous_state = aggregate_state([{
            "category": "secret",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 999.0,
            "__asklake_state_min": 999.0,
            "__asklake_state_max": 999.0,
        }])
        previous = self.saved_result(applied_revision=99, state=previous_state)
        previous.calculation_version = "old-dataset-calculation"
        previous.dataset_id = "another-dataset"
        live_repository = FakeLiveRepository(
            latest_revision=2,
            saved_result=None,
            previous_result=previous,
        )

        with patch(
            "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
            side_effect=ValueError("temporary S3 failure"),
        ):
            response = render_live_widget(self.service(live_repository))

        self.assertEqual(response.data, [])
        self.assertEqual(response.applied_revision, None)
        self.assertEqual(live_repository.latest_result_dataset_ids, ["dataset-live"])

    def test_cached_result_is_not_returned_when_dataset_query_permission_is_denied(self) -> None:
        state = aggregate_state([{
            "category": "secret",
            "__asklake_state_count": 1,
            "__asklake_state_sum": 99.0,
            "__asklake_state_min": 99.0,
            "__asklake_state_max": 99.0,
        }])
        live_repository = FakeLiveRepository(
            latest_revision=1,
            saved_result=self.saved_result(applied_revision=1, state=state),
        )

        with (
            patch(
                "app.services.dashboard_runtime_service.require_dashboard_dataset_query_access",
                side_effect=ApiError("FORBIDDEN", "denied", 403),
            ),
            patch(
                "app.services.dashboard_runtime_service.DashboardDatasetQuerySession",
                side_effect=AssertionError("storage must not open"),
            ) as physical_session,
        ):
            response = render_live_widget(self.service(live_repository))

        physical_session.assert_not_called()
        self.assertEqual(response.data, [])
        self.assertEqual(response.config.error, "DASHBOARD_DATA_FORBIDDEN")
        self.assertEqual(live_repository.save_calls, [])

    def test_calculation_hash_is_stable_and_changes_with_query_semantics(self) -> None:
        first_config = widget_config("sum")
        reordered_config = {
            "yKey": "amount",
            "xKey": "category",
            "color": {"colors": ["#2563eb"]},
            "aggregation": "sum",
        }
        runtime_config = {
            "dataMode": "server_aggregated",
            "error": "ignored-runtime-error",
            "sourceConfig": reordered_config,
        }

        first = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            first_config,
        )
        reordered = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            reordered_config,
        )
        wrapped = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            runtime_config,
        )
        changed_aggregation = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            widget_config("avg"),
        )
        changed_dataset = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-other",
            first_config,
        )
        first_schema = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            first_config,
            schema_identity=[["category", "string"], ["amount", "double"]],
        )
        reordered_same_schema = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            first_config,
            schema_identity=[["category", "string"], ["amount", "double"]],
        )
        changed_schema = DashboardRuntimeService._widget_calculation_version(
            DashboardRuntimeWidgetType.BAR_CHART,
            "dataset-live",
            first_config,
            schema_identity=[["category", "string"], ["amount", "decimal(18,2)"]],
        )

        self.assertEqual(first, reordered)
        self.assertEqual(first, wrapped)
        self.assertEqual(len(first), 64)
        self.assertNotEqual(first, changed_aggregation)
        self.assertNotEqual(first, changed_dataset)
        self.assertEqual(first_schema, reordered_same_schema)
        self.assertNotEqual(first_schema, changed_schema)


class DashboardFreshnessApiTests(unittest.TestCase):
    def test_bulk_query_keeps_healthy_datasets_when_one_dataset_fails(self) -> None:
        def freshness_response(_db, dataset_id, _actor, **_kwargs):
            if dataset_id == "removed-dataset":
                raise ApiError("NOT_FOUND", "removed", 404)
            return DatasetFreshnessResponse(
                dataset_id=dataset_id,
                is_continuous=True,
                latest_revision=3,
                next_check_after_ms=5_000,
            )

        with (
            patch("app.api.dashboard_live.CatalogRepository", return_value=object()),
            patch("app.api.dashboard_live.DashboardLiveRepository", return_value=object()),
            patch(
                "app.api.dashboard_live.dataset_freshness_response",
                side_effect=freshness_response,
            ),
        ):
            response = query_dataset_freshness(
                DatasetFreshnessQueryRequest(
                    dataset_ids=["healthy-dataset", "removed-dataset"],
                ),
                ActorContext(name="dashboard-viewer", role="viewer"),
                SimpleNamespace(),
            )

        self.assertEqual(
            [dataset.dataset_id for dataset in response.datasets],
            ["healthy-dataset"],
        )


if __name__ == "__main__":
    unittest.main()
