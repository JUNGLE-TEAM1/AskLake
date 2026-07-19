from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


def install_module(name: str, **attributes: object) -> types.ModuleType:
    parts = name.split(".")
    for index in range(1, len(parts) + 1):
        current = ".".join(parts[:index])
        if current not in sys.modules:
            module = types.ModuleType(current)
            module.__path__ = []  # type: ignore[attr-defined]
            sys.modules[current] = module
        if index > 1:
            parent = sys.modules[".".join(parts[: index - 1])]
            setattr(parent, parts[index - 1], sys.modules[current])
    module = sys.modules[name]
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


class DummyModel:
    pass


install_module(
    "sqlalchemy",
    select=lambda *args, **kwargs: ("select", args, kwargs),
    text=lambda value: value,
)
install_module(
    "app.application.eks_msk_fault_execution",
    record_eks_msk_authorization_fault=lambda *args, **kwargs: {},
)
install_module(
    "app.application.etl_job_projection",
    stats_from_runs=lambda *args, **kwargs: {},
)
install_module(
    "app.application.etl_run_projection",
    apply_airflow_result_to_reserved_run=lambda *args, **kwargs: None,
    apply_airflow_submit_job_state=lambda *args, **kwargs: None,
    dag_steps_from_airflow_submit=lambda *args, **kwargs: [],
    mark_airflow_submission_unknown=lambda *args, **kwargs: None,
)
install_module("app.core.database", SessionLocal=lambda: None)
install_module(
    "app.models",
    ETLJobModel=DummyModel,
    ETLRunModel=DummyModel,
)
install_module(
    "app.repositories",
    etl_repository=SimpleNamespace(),
)
install_module(
    "app.services",
    etl_service=SimpleNamespace(),
)
install_module(
    "app.services.airflow_client",
    build_airflow_client=lambda: None,
)
install_module(
    "app.services.etl.airflow_operations",
    airflow_run_reservation=lambda *args, **kwargs: None,
    submit_or_reconcile_airflow_job_run=lambda *args, **kwargs: (None, None),
)
install_module(
    "app.services.etl.eks_fixture",
    persisted_eks_mvp_fixture_source_boundary=lambda run: None,
)
install_module(
    "app.services.iceberg_writer_service",
    IcebergWriterService=DummyModel,
)
install_module(
    "scripts.run_eks_day17_multi_spark",
    ACTIVE_RUN_STATUSES={"queued", "running"},
    candidate_fact=lambda job: None,
    collect_preflight=lambda: ({}, []),
)
install_module(
    "scripts.verify_eks_day17_multi_spark_results",
    collect_run_record=lambda *args, **kwargs: {},
)


HELPER_PATH = Path(__file__).with_name("run_eks_day18_phase8_incluster.py")
SPEC = importlib.util.spec_from_file_location("day18_phase8_incluster", HELPER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Day 18 Phase 8 in-cluster helper")
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class Day18Phase8InclusterTest(unittest.TestCase):
    def test_campaign_and_alias_inputs_are_exact(self) -> None:
        campaign = "a" * 32
        self.assertEqual(HELPER.request_campaign({"campaignId": campaign}), campaign)
        self.assertEqual(
            HELPER.request_alias({"alias": "Run D"}),
            ("Run D", "Run A"),
        )
        with self.assertRaises(HELPER.Day18Phase8Error):
            HELPER.request_campaign({"campaignId": "not-approved"})
        with self.assertRaises(HELPER.Day18Phase8Error):
            HELPER.request_alias({"alias": "Run A"})

    def test_marker_update_preserves_existing_state_and_created_time(self) -> None:
        run = SimpleNamespace(task_states={"existing": {"status": "kept"}})
        HELPER.update_marker(
            run,
            campaign_id="b" * 32,
            alias="Run E",
            source_alias="Run B",
            state="reserved",
        )
        created_at = run.task_states["day18Phase8"]["createdAt"]
        HELPER.update_marker(
            run,
            campaign_id="b" * 32,
            alias="Run E",
            source_alias="Run B",
            state="airflow_submitted",
        )
        self.assertEqual(run.task_states["existing"], {"status": "kept"})
        self.assertEqual(
            run.task_states["day18Phase8"]["createdAt"],
            created_at,
        )
        self.assertEqual(
            run.task_states["day18Phase8"]["state"],
            "airflow_submitted",
        )

    def test_private_identity_requires_the_persisted_run_boundary(self) -> None:
        job = SimpleNamespace(id="job-private", dataset_id="dataset-private")
        run = SimpleNamespace(
            run_id="run-private",
            task_states={
                "eksMvpFixture": {
                    "icebergTable": "table_private",
                    "sourceBoundary": {
                        "consumerGroup": "group-private",
                        "outputPath": "s3a://private/output/run-private",
                        "checkpointPath": "s3a://private/checkpoint/run-private",
                        "fixtureBatchId": "fixture-private",
                        "expectedCount": 100,
                    },
                },
            },
        )
        identity = HELPER.private_identity(
            job,
            run,
            alias="Run D",
            source_alias="Run A",
        )
        self.assertEqual(identity["alias"], "Run D")
        self.assertEqual(identity["runId"], "run-private")
        self.assertEqual(identity["expectedCount"], 100)
        run.task_states["eksMvpFixture"]["sourceBoundary"]["expectedCount"] = 99
        with self.assertRaises(HELPER.Day18Phase8Error):
            HELPER.private_identity(
                job,
                run,
                alias="Run D",
                source_alias="Run A",
            )

    def test_target_validation_is_bound_to_the_approved_candidate(self) -> None:
        job = SimpleNamespace(id="job-private")
        fact = SimpleNamespace(
            alias="Run A",
            job_id="job-private",
            dataset_id="dataset-private",
            batch_id="batch-private",
            consumer_group="group-private",
            target_table="table-private",
            expected_count=100,
        )
        original = HELPER.candidate_fact
        HELPER.candidate_fact = lambda value: fact if value is job else None
        try:
            request = {
                "alias": "Run D",
                "target": {
                    "alias": "Run D",
                    "sourceAlias": "Run A",
                    "jobId": "job-private",
                    "datasetId": "dataset-private",
                    "fixtureBatchId": "batch-private",
                    "consumerGroup": "group-private",
                    "icebergTable": "table-private",
                    "expectedCount": 100,
                },
            }
            db = SimpleNamespace(get=lambda model, identity: job)
            _, target, alias, source_alias = HELPER.validate_target(db, request)
            self.assertEqual((alias, source_alias), ("Run D", "Run A"))
            self.assertEqual(target["consumerGroup"], "group-private")
            request["target"]["consumerGroup"] = "other-group"
            with self.assertRaises(HELPER.Day18Phase8Error):
                HELPER.validate_target(db, request)
        finally:
            HELPER.candidate_fact = original

    def test_inspect_exposes_only_sanitized_campaign_recovery_state(self) -> None:
        run = SimpleNamespace(
            status="running",
            airflow_state="queued",
            execution_owner=None,
            execution_generation=1,
            task_states={
                "day18Phase8": {"state": "msk_fault_recorded"},
                "faultAttempts": [{"kind": "msk_authorization"}],
                "sparkExecution": {},
                "sparkResult": {},
                "catalogResult": {},
            },
        )

        class Database:
            def execute(self, statement: object) -> None:
                self.statement = statement

            def close(self) -> None:
                return None

        original_session = HELPER.SessionLocal
        original_require = HELPER.require_campaign_run
        original_identity = HELPER.private_identity
        HELPER.SessionLocal = Database
        HELPER.require_campaign_run = lambda db, request: (
            SimpleNamespace(),
            run,
            {},
            "Run D",
            "Run A",
            "c" * 32,
        )
        HELPER.private_identity = lambda *args, **kwargs: {
            "runId": "private-run",
        }
        try:
            result = HELPER.inspect_fault_run({})
            self.assertEqual(result["campaignState"], "msk_fault_recorded")
            self.assertEqual(result["faultAttemptCount"], 1)
            self.assertEqual(result["executionGeneration"], 1)
            self.assertNotIn("day18Phase8", result)
        finally:
            HELPER.SessionLocal = original_session
            HELPER.require_campaign_run = original_require
            HELPER.private_identity = original_identity

    def test_preflight_requires_exact_three_targets_and_zero_activity(self) -> None:
        facts = [
            SimpleNamespace(
                alias=f"Run {letter}",
                job_id=f"job-{letter}",
                dataset_id=f"dataset-{letter}",
                batch_id="shared-batch",
                consumer_group=f"group-{letter}",
                target_table=f"table-{letter}",
                expected_count=100,
            )
            for letter in ("A", "B", "C")
        ]
        original = HELPER.collect_preflight
        HELPER.collect_preflight = lambda: (
            {
                "status": "passed",
                "counts": {
                    "activeFixtureRuns": 0,
                    "continuousRuntimes": 1,
                    "continuousSessions": 4,
                },
                "checks": {"sparkApplicationListReadable": True},
            },
            facts,
        )
        try:
            request = {
                "boundedTargets": [
                    {
                        "alias": fact.alias,
                        "jobId": fact.job_id,
                        "datasetId": fact.dataset_id,
                        "fixtureBatchId": fact.batch_id,
                        "consumerGroup": fact.consumer_group,
                        "icebergTable": fact.target_table,
                        "expectedCount": fact.expected_count,
                    }
                    for fact in facts
                ]
            }
            result = HELPER.preflight(request)
            self.assertEqual(result["status"], "passed")
            self.assertTrue(result["checks"]["continuousRowsReadable"])
            self.assertEqual(result["counts"]["continuousRuntimes"], 1)
            self.assertEqual(result["counts"]["continuousSessions"], 4)
            request["boundedTargets"][0]["jobId"] = "other-job"
            self.assertEqual(HELPER.preflight(request)["status"], "blocked")
        finally:
            HELPER.collect_preflight = original


if __name__ == "__main__":
    unittest.main()
