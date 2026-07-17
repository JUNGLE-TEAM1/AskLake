from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path
import unittest

from app.application.catalog_publication import publish_catalog_payload
from app.application.pipeline_mapping import (
    CreatePipelineMappingContext,
    map_create_request_to_job,
)
from app.application.snapshot_commands import (
    SnapshotCommandViolation,
    SnapshotExecutionPath,
    plan_snapshot_command,
)
from app.domain.dataset_identity import DatasetIdentity
from app.domain.pipeline_contract import (
    create_request_violations,
    target_contract_violation,
)
from app.schemas.etl import CreatePipelineRequest
from app.models import ETLJobModel, ETLRunModel
from app.services.airflow_client import AirflowDagRun
from app.services.etl_service import submit_or_reconcile_airflow_job_run


class FakeCatalogWriter:
    def __init__(self) -> None:
        self.payloads: dict[str, dict] = {}
        self.save_calls = 0
        self.db = None

    def get_dataset_payload(self, dataset_id: str):
        payload = self.payloads.get(dataset_id)
        return dict(payload) if payload else None

    def get_dataset_payload_for_update(self, dataset_id: str):
        return self.get_dataset_payload(dataset_id)

    def get_dataset_payload_by_name(self, dataset_name: str):
        return next((dict(value) for value in self.payloads.values() if value["name"] == dataset_name), None)

    def get_lineage_payload(self, dataset_id: str):
        payload = self.get_dataset_payload(dataset_id)
        return payload.get("lineageGraph") if payload else None

    def save_dataset_payload(self, payload: dict):
        self.save_calls += 1
        self.payloads[str(payload["id"])] = dict(payload)
        return dict(payload)


class PipelineContractTests(unittest.TestCase):
    def test_kafka_snapshot_target_policy_is_pure_and_explicit(self) -> None:
        violation = target_contract_violation(
            source_type="Stream / Kafka",
            execution_mode="snapshot",
            target_layer="GOLD",
            target_format="jsonl",
        )
        self.assertIsNotNone(violation)
        self.assertEqual(violation.code, "TARGET_LAYER_UNSUPPORTED")
        self.assertEqual(violation.details["supportedLayers"], ["RAW", "BRONZE", "SILVER"])

    def test_create_contract_preserves_record_parsing_requirement(self) -> None:
        request = SimpleNamespace(
            execution_mode="snapshot",
            job_name="click pipeline",
            owner="data-team-01",
            permission_grants=[],
            record_parsing=SimpleNamespace(
                columns=[SimpleNamespace(name="event id"), SimpleNamespace(name="event_id")],
                enabled=True,
                expected_field_count=2,
            ),
            schema_columns=[SimpleNamespace(included=True, target_name="event_id")],
            source_label="click-events.log",
            source_type="File / S3",
            target_dataset="click_events",
            target_format="jsonl",
            target_layer="BRONZE",
        )
        violations = create_request_violations(
            request,
            normalize_column_name=lambda value: value.replace(" ", "_").lower(),
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("recordParsing.columns[uniqueName]", violations[0].message)

    def test_create_mapper_keeps_raw_record_parsing_and_source_identity(self) -> None:
        request = CreatePipelineRequest.model_validate({
            "id": "click-pipeline",
            "jobName": "click pipeline",
            "owner": "data-team-01",
            "recordParsing": {
                "columns": [{"inferredType": "String", "name": "event_id", "position": 0}],
                "delimiterKind": "whitespace",
                "delimiterPattern": "\\s+",
                "enabled": True,
                "expectedFieldCount": 1,
                "header": False,
            },
            "scheduleLabel": "스케줄링 건너뛰기",
            "schemaColumns": [{
                "included": True,
                "nullable": False,
                "sourceName": "event_id",
                "targetName": "event_id",
                "type": "String",
            }],
            "sourceConfig": [["Bucket", "raw"], ["Object", "click-events.log"]],
            "sourceLabel": "click-events.log",
            "sourceType": "File / S3",
            "targetDataset": "click_events",
            "targetFormat": "parquet",
            "targetLayer": "GOLD",
        })
        job = map_create_request_to_job(
            request,
            CreatePipelineMappingContext(
                continuous_config=None,
                created_by="data-team-01",
                created_by_profile={"name": "data-team-01"},
                dag_steps=[],
                dataset_id="ds_click_events",
                iceberg_target={"catalog": "iceberg", "namespace": "asklake", "table": "click_events"},
                job_id="JOB-CLICK",
                metrics={"schema_columns": 1},
                next_run="-",
                schedule_policy={},
                stats={},
            ),
        )
        self.assertEqual(job.source_config, [["Bucket", "raw"], ["Object", "click-events.log"]])
        self.assertTrue(job.record_parsing["enabled"])
        self.assertEqual(job.record_parsing["expectedFieldCount"], 1)


class SnapshotCommandTests(unittest.TestCase):
    def test_duplicate_snapshot_start_is_rejected_before_runtime(self) -> None:
        plan = plan_snapshot_command(
            command="run",
            execution_mode="snapshot",
            has_active_schedule=False,
            has_schedule_label=False,
            job_id="JOB-1",
            job_kind=None,
            status="running",
        )
        self.assertIsInstance(plan, SnapshotCommandViolation)
        self.assertEqual(plan.code, "CONFLICT")

    def test_trino_snapshot_uses_finite_trino_path(self) -> None:
        plan = plan_snapshot_command(
            command="retry",
            execution_mode="snapshot",
            has_active_schedule=False,
            has_schedule_label=False,
            job_id="JOB-SQL",
            job_kind="trino_sql_materialization",
            status="failed",
        )
        self.assertEqual(plan.execution_path, SnapshotExecutionPath.TRINO)
        self.assertEqual(plan.action, "etl.run.retry_requested")

    def test_airflow_response_loss_reconciles_the_reserved_run(self) -> None:
        reserved = ETLRunModel(
            run_id="run-reserved",
            job_id="JOB-AIRFLOW",
            status="queued",
            started_at="2026-07-16T00:00:00Z",
            ended_at="-",
            duration="-",
            input_rows="-",
            output_rows="-",
            output_path="-",
            failed_stage="-",
            error_summary="-",
        )
        job = ETLJobModel(
            id="JOB-AIRFLOW",
            name="snapshot",
            owner="data-team-01",
            status="scheduled",
            tag="[생성]",
            source="PostgreSQL / orders",
            target="orders",
            schedule="스케줄링 건너뛰기",
            source_config=[],
            source_label="orders",
            source_type="PostgreSQL",
            schema_columns=[],
            schema_sample_rows=[],
            target_format="parquet",
            target_layer="GOLD",
            transform_output_columns=[],
            transform_steps=[],
            quality_invalid_rows=[],
            quality_rules=[],
            last_run="-",
            last_state="scheduled",
            next_run="-",
            stats={},
            dag_steps=[],
        )

        class LostResponseAirflow:
            config = SimpleNamespace(dag_id="asklake_etl")

            def trigger_dag_run(self, **_kwargs):
                raise TimeoutError("response lost")

            def get_dag_run(self, run_id: str):
                return AirflowDagRun(
                    dag_id="asklake_etl",
                    dag_run_id=run_id,
                    state="queued",
                    asklake_status="queued",
                    conf={},
                    raw={"reconciled": True},
                )

            def dag_run_url(self, run_id: str):
                return f"http://airflow/runs/{run_id}"

        reconciled, error = submit_or_reconcile_airflow_job_run(
            job,
            "run",
            reserved,
            LostResponseAirflow(),
        )
        self.assertIsNone(error)
        self.assertEqual(reconciled.run_id, reserved.run_id)
        self.assertEqual(reconciled.airflow_dag_run_id, reserved.run_id)


class CatalogBoundaryTests(unittest.TestCase):
    def test_same_materialization_version_is_idempotent(self) -> None:
        writer = FakeCatalogWriter()
        payload = {
            "id": "ds_clicks",
            "name": "clicks",
            "sourceRunId": "run-1",
            "storageLocation": "s3://lake/clicks/run-1",
            "queryEngineTable": {
                "catalog": "iceberg",
                "schema": "asklake",
                "table": "clicks",
                "format": "iceberg",
            },
        }
        first = publish_catalog_payload(writer, payload, require_version_identity=True)
        second = publish_catalog_payload(writer, dict(payload), require_version_identity=True)
        self.assertEqual(first.status, "published")
        self.assertEqual(second.status, "already_published")
        self.assertEqual(writer.save_calls, 1)

    def test_identity_requires_id_and_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "dataset id and name"):
            DatasetIdentity.from_payload({"id": "", "name": "clicks"}).require_publishable()

    def test_sql_and_catalog_services_depend_on_ports(self) -> None:
        app_root = Path(__file__).resolve().parents[1] / "app"
        sql_source = (app_root / "services" / "sql_service.py").read_text(encoding="utf-8")
        registration_source = (
            app_root / "services" / "query_engine_registration_service.py"
        ).read_text(encoding="utf-8")

        self.assertIn("CatalogReaderPort", sql_source)
        self.assertNotIn("from app.repositories.etl_repository", sql_source)
        self.assertIn("CatalogWriterPort", registration_source)


if __name__ == "__main__":
    unittest.main()
