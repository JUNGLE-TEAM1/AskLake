from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app import continuous_worker
from app.services import continuous_runtime_sync


class ContinuousWorkerScopeTests(unittest.TestCase):
    def test_default_all_scope_preserves_legacy_single_lease(self) -> None:
        kafka = Mock()
        continuous_sql = Mock()
        with (
            patch.object(
                continuous_worker,
                "settings",
                SimpleNamespace(continuous_worker_scope="all", continuous_control_lease_seconds=30),
            ),
            patch.object(continuous_worker, "SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_worker, "acquire_or_renew", return_value=1) as acquire,
            patch.dict(
                continuous_worker._SCOPES,
                {
                    "kafka": ("kafka-continuous-runtime-sync", kafka),
                    "continuous_sql": ("continuous-sql-runtime-sync", continuous_sql),
                },
                clear=True,
            ),
        ):
            self.assertTrue(continuous_worker.run_once())

        acquire.assert_called_once()
        self.assertEqual(acquire.call_args.kwargs["control_plane"], "continuous-runtime-sync")
        kafka.assert_called_once_with()
        continuous_sql.assert_called_once_with()

    def test_default_all_scope_without_legacy_lease_runs_nothing(self) -> None:
        kafka = Mock()
        continuous_sql = Mock()
        with (
            patch.object(
                continuous_worker,
                "settings",
                SimpleNamespace(continuous_worker_scope="all", continuous_control_lease_seconds=30),
            ),
            patch.object(continuous_worker, "SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_worker, "acquire_or_renew", return_value=None),
            patch.dict(
                continuous_worker._SCOPES,
                {
                    "kafka": ("kafka-continuous-runtime-sync", kafka),
                    "continuous_sql": ("continuous-sql-runtime-sync", continuous_sql),
                },
                clear=True,
            ),
        ):
            self.assertFalse(continuous_worker.run_once())

        kafka.assert_not_called()
        continuous_sql.assert_not_called()

    def test_kafka_scope_never_runs_continuous_sql(self) -> None:
        kafka = Mock()
        continuous_sql = Mock()
        with (
            patch.object(
                continuous_worker,
                "settings",
                SimpleNamespace(continuous_worker_scope="kafka", continuous_control_lease_seconds=30),
            ),
            patch.object(continuous_worker, "SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_worker, "acquire_or_renew", return_value=7) as acquire,
            patch.dict(
                continuous_worker._SCOPES,
                {
                    "kafka": ("kafka-continuous-runtime-sync", kafka),
                    "continuous_sql": ("continuous-sql-runtime-sync", continuous_sql),
                },
                clear=True,
            ),
        ):
            self.assertTrue(continuous_worker.run_once())

        self.assertEqual(acquire.call_args.kwargs["control_plane"], "kafka-continuous-runtime-sync")
        kafka.assert_called_once_with()
        continuous_sql.assert_not_called()

    def test_scope_without_lease_performs_no_side_effect(self) -> None:
        kafka = Mock()
        with (
            patch.object(
                continuous_worker,
                "settings",
                SimpleNamespace(continuous_worker_scope="kafka", continuous_control_lease_seconds=30),
            ),
            patch.object(continuous_worker, "SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_worker, "acquire_or_renew", return_value=None),
            patch.dict(
                continuous_worker._SCOPES,
                {"kafka": ("kafka-continuous-runtime-sync", kafka)},
                clear=True,
            ),
        ):
            self.assertFalse(continuous_worker.run_once())

        kafka.assert_not_called()

    def test_settings_reject_unknown_scope(self) -> None:
        from pydantic import ValidationError

        from app.core.config import Settings

        with self.assertRaises(ValidationError):
            Settings(continuous_worker_scope="both-ish", _env_file=None)

    def test_settings_require_generation_and_kafka_scope_for_eks_owner(self) -> None:
        from pydantic import ValidationError

        from app.core.config import Settings

        with self.assertRaises(ValidationError):
            Settings(continuous_worker_owner="eks-continuous-worker-v1", _env_file=None)
        with self.assertRaises(ValidationError):
            Settings(
                continuous_worker_owner="eks-continuous-worker-v1",
                continuous_worker_scope="continuous_sql",
                continuous_worker_generation="g1",
                _env_file=None,
            )
        configured = Settings(
            continuous_worker_owner="eks-kafka-connect-clickhouse-v2",
            continuous_worker_scope="kafka",
            continuous_worker_generation="v2-canary-g1",
            _env_file=None,
        )
        self.assertEqual(
            configured.continuous_worker_owner,
            "eks-kafka-connect-clickhouse-v2",
        )

    def test_settings_require_generation_and_continuous_sql_scope_for_v2_owner(self) -> None:
        from pydantic import ValidationError

        from app.core.config import Settings

        with self.assertRaises(ValidationError):
            Settings(continuous_worker_owner="eks-continuous-worker-v2", _env_file=None)
        with self.assertRaises(ValidationError):
            Settings(
                continuous_worker_owner="eks-continuous-worker-v2",
                continuous_worker_scope="kafka",
                continuous_worker_generation="g1",
                _env_file=None,
            )
        settings = Settings(
            continuous_worker_owner="eks-continuous-worker-v2",
            continuous_worker_scope="continuous_sql",
            continuous_worker_generation="g1",
            _env_file=None,
        )
        self.assertEqual(settings.continuous_worker_scope, "continuous_sql")

    def test_eks_owner_claim_must_match_full_runtime_identity(self) -> None:
        runtime = SimpleNamespace(
            broker="broker:9098",
            topic="asklake.eks-realtime.fixture.g1",
            consumer_group_id="asklake-eks-realtime-v1-g1",
            checkpoint_path="s3a://output/checkpoints/job/target/g1",
            metrics={},
            status="stopped",
        )
        claim = continuous_runtime_sync.assign_runtime_owner_claim(
            runtime,
            owner="eks-continuous-worker-v1",
            generation="g1",
            fencing_token="transfer-fence-1",
            state_revision=1,
        )
        self.assertIs(runtime.metrics["ownerClaim"], claim)
        expected_settings = SimpleNamespace(
            continuous_worker_owner="eks-continuous-worker-v1",
            continuous_worker_generation="g1",
        )
        with patch.object(continuous_runtime_sync, "settings", expected_settings):
            self.assertTrue(continuous_runtime_sync.runtime_matches_owner_claim(runtime))
            self.assertFalse(continuous_runtime_sync.runtime_allowed_for_worker(runtime, strict_owner=False))
            runtime.metrics["ownerClaim"]["generation"] = "g2"
            self.assertFalse(continuous_runtime_sync.runtime_matches_owner_claim(runtime))

    def test_owner_transfer_rejects_active_runtime(self) -> None:
        runtime = SimpleNamespace(
            broker="broker:9098", topic="topic", consumer_group_id="group",
            checkpoint_path="s3a://output/checkpoint", metrics={}, status="running",
        )
        with self.assertRaises(ValueError):
            continuous_runtime_sync.assign_runtime_owner_claim(
                runtime, owner="eks-continuous-worker-v1", generation="g1",
                fencing_token="fence", state_revision=1,
            )

    def test_v2_owner_claim_uses_the_same_full_identity_fence(self) -> None:
        runtime = SimpleNamespace(
            broker="broker:9098",
            topic="asklake.eks-realtime.v2.fixture.g1",
            consumer_group_id="asklake-eks-realtime-v2-g1",
            checkpoint_path="keepermap:///asklake/realtime-v2/connect-state/g1",
            metrics={},
            status="paused",
        )
        continuous_runtime_sync.assign_runtime_owner_claim(
            runtime,
            owner="eks-kafka-connect-clickhouse-v2",
            generation="g1",
            fencing_token="v2-fence-1",
            state_revision=1,
        )
        expected_settings = SimpleNamespace(
            continuous_worker_owner="eks-kafka-connect-clickhouse-v2",
            continuous_worker_generation="g1",
        )
        with patch.object(continuous_runtime_sync, "settings", expected_settings):
            self.assertTrue(continuous_runtime_sync.runtime_matches_owner_claim(runtime))
            runtime.consumer_group_id = "asklake-eks-realtime-v2-other"
            self.assertFalse(continuous_runtime_sync.runtime_matches_owner_claim(runtime))

    def test_strict_owner_skips_unclaimed_job_side_effects(self) -> None:
        job = SimpleNamespace(id="job-1", execution_mode="continuous")
        runtime = SimpleNamespace(
            broker="broker:9098",
            topic="asklake.eks-realtime.fixture.g1",
            consumer_group_id="asklake-eks-realtime-v1-g1",
            checkpoint_path="s3a://output/checkpoints/job/target/g1",
            metrics={},
            status="running",
            last_error=None,
        )
        hooks = continuous_runtime_sync.ContinuousRuntimeSyncHooks(
            reconcile_stale_maintenance=Mock(),
            refresh_runtime=Mock(),
            report_has_unacknowledged_publication=Mock(return_value=False),
            has_pending_replay_catalog=Mock(return_value=False),
        )
        with (
            patch("app.core.database.SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_runtime_sync.etl_repository, "get_job", return_value=job),
            patch.object(continuous_runtime_sync.etl_repository, "get_kafka_continuous_runtime", return_value=runtime),
        ):
            continuous_runtime_sync._sync_job(
                job.id,
                {"running"},
                {"stopped"},
                hooks,
                strict_owner=True,
            )

        hooks.refresh_runtime.assert_not_called()

    def test_legacy_ec2_skips_global_maintenance_when_eks_claim_exists(self) -> None:
        job = SimpleNamespace(id="job-1", execution_mode="continuous")
        runtime = SimpleNamespace(metrics={"ownerClaim": {"owner": "eks-continuous-worker-v1"}})
        hooks = continuous_runtime_sync.ContinuousRuntimeSyncHooks(
            reconcile_stale_maintenance=Mock(), refresh_runtime=Mock(),
            report_has_unacknowledged_publication=Mock(), has_pending_replay_catalog=Mock(),
        )
        legacy_settings = SimpleNamespace(
            continuous_worker_owner="ec2-continuous-worker",
            continuous_worker_generation=None,
        )
        with (
            patch.object(continuous_runtime_sync, "settings", legacy_settings),
            patch("app.core.database.SessionLocal", side_effect=lambda: nullcontext(object())),
            patch.object(continuous_runtime_sync.etl_repository, "list_job_models", return_value=[job]),
            patch.object(continuous_runtime_sync.etl_repository, "get_kafka_continuous_runtime", return_value=runtime),
            patch.object(continuous_runtime_sync, "_sync_job") as sync_job,
        ):
            continuous_runtime_sync.sync_active_kafka_continuous_jobs(hooks)

        hooks.reconcile_stale_maintenance.assert_not_called()
        sync_job.assert_called_once()


if __name__ == "__main__":
    unittest.main()
