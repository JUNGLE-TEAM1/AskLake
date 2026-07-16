from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from threading import Lock
import unittest

from app.application.continuous_publication import (
    ContinuousPublicationHooks,
    PublicationCatalogEvidence,
    PublicationInputEvidence,
    PublicationOutputEvidence,
    execute_continuous_publication,
)


class FakeSession:
    def __init__(self) -> None:
        self.rollback_count = 0

    def rollback(self) -> None:
        self.rollback_count += 1


class ExpiringFakeSession(FakeSession):
    def __init__(self, runtime) -> None:
        super().__init__()
        self.runtime = runtime

    def rollback(self) -> None:
        super().rollback()
        self.runtime.metrics = {}
        self.runtime.last_error = None


class PublicationHarness:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.catalog_runs: set[str] = set()
        self.dashboard_runs: set[str] = set()
        self.fail_stage: str | None = None
        self.lock = Lock()

    def hooks(self) -> ContinuousPublicationHooks:
        return ContinuousPublicationHooks(
            prepare=self.prepare,
            verify_output=self.verify_output,
            verify_manifest=self.verify_manifest,
            register_catalog=self.register_catalog,
            publish_dashboard=self.publish_dashboard,
            update_job_stats=lambda *_args: self.events.append("stats"),
            compact_error=lambda value: str(value),
        )

    def prepare(self, _job, _runtime, publication, _identity):
        self.events.append("prepare")
        return PublicationInputEvidence(
            data_path=publication.get("dataPath"),
            manifest_path=publication["manifestPath"],
            source_ranges=publication["sourceRanges"],
        )

    def verify_output(self, _job, _runtime, _publication, identity, _inputs):
        self.events.append("output")
        if self.fail_stage == "output":
            raise RuntimeError("output unavailable")
        return PublicationOutputEvidence(
            target_uri="s3a://lake/table",
            verified_result={
                "icebergCommit": {"snapshotId": "1"},
                "materializationOutputPath": "s3a://lake/table",
                "runId": identity.run_id,
            },
        )

    def verify_manifest(self, _job, _publication, _inputs):
        self.events.append("manifest")
        if self.fail_stage == "manifest":
            raise RuntimeError("manifest write failed")

    def register_catalog(
        self,
        _db,
        _job,
        _runtime,
        _publication,
        identity,
        _inputs,
        _output,
    ):
        self.events.append("catalog")
        if self.fail_stage == "catalog":
            raise RuntimeError("catalog timeout")
        with self.lock:
            created = identity.run_id not in self.catalog_runs
            self.catalog_runs.add(identity.run_id)
        return PublicationCatalogEvidence(
            dataset_id="dataset-1",
            materialization_mode="snapshot" if created else "delta",
            catalog_created=created,
        )

    def publish_dashboard(
        self,
        _db,
        _job,
        _runtime,
        _publication,
        identity,
        _inputs,
        _output,
        _catalog,
    ):
        self.events.append("dashboard")
        if self.fail_stage == "dashboard":
            raise RuntimeError("dashboard timeout")
        with self.lock:
            self.dashboard_runs.add(identity.run_id)


def make_job():
    return SimpleNamespace(id="job-1")


def make_runtime():
    return SimpleNamespace(last_error=None, metrics={}, status="running")


def make_publication(batch_id: int = 0):
    run_id = f"continuous:job-1:batch:{batch_id}:boundary"
    return {
        "batchId": batch_id,
        "dataPath": "s3a://lake/table",
        "manifestPath": f"s3a://lake/_batch-manifests/batch_id={batch_id}",
        "runId": run_id,
        "sourceBoundary": {"boundaryId": f"boundary-{batch_id}"},
        "sourceRanges": [{
            "topic": "events",
            "partition": 0,
            "startOffset": batch_id,
            "endOffset": batch_id + 1,
        }],
        "storedCount": 1,
    }


class ContinuousPublicationWorkflowTests(unittest.TestCase):
    def execute(self, harness, runtime=None, publication=None):
        runtime = runtime or make_runtime()
        session = FakeSession()
        result = execute_continuous_publication(
            session,
            make_job(),
            runtime,
            publication or make_publication(),
            hooks=harness.hooks(),
        )
        return result, runtime, session

    def test_output_success_then_manifest_failure_keeps_stage_evidence(self) -> None:
        harness = PublicationHarness()
        harness.fail_stage = "manifest"

        result, runtime, session = self.execute(harness)

        self.assertFalse(result)
        self.assertEqual(harness.events, ["prepare", "output", "manifest"])
        stages = runtime.metrics["publicationWorkflow"]["stages"]
        self.assertEqual(stages["output"]["status"], "succeeded")
        self.assertEqual(stages["manifest"]["status"], "failed")
        self.assertEqual(runtime.metrics["runtimeContract"]["lastError"]["stage"], "materialization")
        self.assertEqual(session.rollback_count, 1)

    def test_manifest_success_then_catalog_timeout_does_not_publish_dashboard(self) -> None:
        harness = PublicationHarness()
        harness.fail_stage = "catalog"

        result, runtime, _session = self.execute(harness)

        self.assertFalse(result)
        self.assertEqual(harness.events, ["prepare", "output", "manifest", "catalog"])
        stages = runtime.metrics["publicationWorkflow"]["stages"]
        self.assertEqual(stages["manifest"]["status"], "succeeded")
        self.assertEqual(stages["catalog"]["status"], "failed")
        self.assertNotIn("dashboard", stages)

    def test_transaction_rollback_does_not_erase_stage_diagnostics(self) -> None:
        harness = PublicationHarness()
        harness.fail_stage = "catalog"
        runtime = make_runtime()
        session = ExpiringFakeSession(runtime)

        result = execute_continuous_publication(
            session,
            make_job(),
            runtime,
            make_publication(),
            hooks=harness.hooks(),
        )

        self.assertFalse(result)
        self.assertEqual(session.rollback_count, 1)
        stages = runtime.metrics["publicationWorkflow"]["stages"]
        self.assertEqual(stages["output"]["status"], "succeeded")
        self.assertEqual(stages["manifest"]["status"], "succeeded")
        self.assertEqual(stages["catalog"]["status"], "failed")

    def test_catalog_success_survives_dashboard_failure(self) -> None:
        harness = PublicationHarness()
        harness.fail_stage = "dashboard"
        publication = make_publication()

        result, runtime, _session = self.execute(harness, publication=publication)

        self.assertFalse(result)
        self.assertIn(publication["runId"], harness.catalog_runs)
        self.assertNotIn(publication["runId"], harness.dashboard_runs)
        self.assertEqual(runtime.status, "running")
        self.assertEqual(
            runtime.metrics["runtimeContract"]["lastError"]["stage"],
            "dashboard_publication",
        )

    def test_same_batch_retry_resumes_without_duplicate_catalog_or_dashboard(self) -> None:
        harness = PublicationHarness()
        harness.fail_stage = "dashboard"
        runtime = make_runtime()
        publication = make_publication()
        first, _runtime, _session = self.execute(harness, runtime, publication)
        harness.fail_stage = None

        second, runtime, _session = self.execute(harness, runtime, publication)

        self.assertFalse(first)
        self.assertTrue(second)
        self.assertEqual(harness.catalog_runs, {publication["runId"]})
        self.assertEqual(harness.dashboard_runs, {publication["runId"]})
        workflow = runtime.metrics["publicationWorkflow"]
        self.assertEqual(workflow["status"], "completed")
        self.assertEqual(workflow["stages"]["dashboard"]["attempts"], 2)

    def test_backend_restart_recovers_catalog_without_recreating_output(self) -> None:
        harness = PublicationHarness()
        publication = make_publication()
        harness.catalog_runs.add(publication["runId"])

        result, runtime, _session = self.execute(harness, make_runtime(), publication)

        self.assertTrue(result)
        self.assertEqual(harness.catalog_runs, {publication["runId"]})
        self.assertEqual(harness.dashboard_runs, {publication["runId"]})
        self.assertEqual(runtime.metrics["publicationWorkflow"]["status"], "completed")

    def test_two_reconcilers_share_the_same_idempotency_identity(self) -> None:
        harness = PublicationHarness()
        publication = make_publication()

        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(self.execute, harness, make_runtime(), publication)
            second_future = pool.submit(self.execute, harness, make_runtime(), publication)
            first, first_runtime, _session = first_future.result()
            second, second_runtime, _session = second_future.result()

        self.assertTrue(first)
        self.assertTrue(second)
        self.assertEqual(harness.catalog_runs, {publication["runId"]})
        self.assertEqual(harness.dashboard_runs, {publication["runId"]})
        self.assertEqual(
            first_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
            second_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
        )

    def test_output_evidence_is_part_of_the_idempotency_identity(self) -> None:
        harness = PublicationHarness()
        first_publication = make_publication()
        second_publication = {
            **first_publication,
            "dataPath": "s3a://lake/replaced-table",
        }

        first, first_runtime, _session = self.execute(harness, make_runtime(), first_publication)
        second, second_runtime, _session = self.execute(harness, make_runtime(), second_publication)

        self.assertTrue(first)
        self.assertTrue(second)
        self.assertNotEqual(
            first_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
            second_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
        )

    def test_source_range_order_does_not_change_the_idempotency_identity(self) -> None:
        harness = PublicationHarness()
        first_publication = make_publication()
        first_publication["sourceRanges"] = [
            {"topic": "events", "partition": 1, "startOffset": 0, "endOffset": 1},
            {"topic": "events", "partition": 0, "startOffset": 0, "endOffset": 1},
        ]
        second_publication = {
            **first_publication,
            "sourceRanges": list(reversed(first_publication["sourceRanges"])),
        }

        first, first_runtime, _session = self.execute(harness, make_runtime(), first_publication)
        second, second_runtime, _session = self.execute(harness, make_runtime(), second_publication)

        self.assertTrue(first)
        self.assertTrue(second)
        self.assertEqual(
            first_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
            second_runtime.metrics["publicationWorkflow"]["idempotencyKey"],
        )

    def test_legacy_manifest_without_optional_fingerprints_is_accepted(self) -> None:
        harness = PublicationHarness()
        publication = make_publication()
        publication.pop("sourceBoundary")

        result, runtime, _session = self.execute(harness, make_runtime(), publication)

        self.assertTrue(result)
        self.assertEqual(runtime.metrics["publicationWorkflow"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
