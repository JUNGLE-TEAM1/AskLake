from __future__ import annotations

import json
import os

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.schemas.iceberg import IcebergWriterTarget
from app.services.etl_service import execute_airflow_run
from app.services.iceberg_writer_service import IcebergWriterService


def required(name: str) -> str:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    run_id = required("RUN_ID")
    job_id = required("JOB_ID")
    expected_count = int(required("EXPECTED_COUNT"))
    expected_image_digest = required("SPARK_IMAGE").split("@")[-1]
    verify_retry = os.environ.get("VERIFY_RETRY") == "true"

    db = SessionLocal()
    try:
        # A one-shot verifier must initialize repository metadata before it opens
        # its own read transaction. Reversing this order can self-deadlock.
        etl_repository.ensure_schema(db)
        job = db.get(ETLJobModel, job_id)
        run = db.get(ETLRunModel, run_id)
        if job is None or run is None or run.job_id != job.id:
            raise RuntimeError("persisted bounded Run identity is invalid")
        dataset = db.get(CatalogDatasetModel, job.dataset_id) if job.dataset_id else None
        if dataset is None:
            raise RuntimeError("persisted bounded Dataset is missing")

        task_states = run.task_states or {}
        spark_result = task_states.get("sparkResult") or {}
        catalog_result = task_states.get("catalogResult") or {}
        fixture = task_states.get("eksMvpFixture") or {}
        execution = spark_result.get("kubernetesExecution") or {}
        commit = spark_result.get("icebergCommit") or {}
        boundary = fixture.get("sourceBoundary") or {}
        materializations = [
            item
            for item in ((dataset.payload or {}).get("materializationRuns") or [])
            if isinstance(item, dict) and item.get("runId") == run.run_id
        ]

        target = IcebergWriterTarget.model_validate(job.iceberg_target)
        service = IcebergWriterService()
        evidence = service.verify_commit(
            target,
            created_table=commit.get("createdTable") is True,
            job_id=job.id,
            run_id=run.run_id,
            expected_snapshot_id=str(commit.get("snapshotId") or ""),
            schema_fingerprint=commit.get("schemaFingerprint"),
            rule_fingerprint=commit.get("ruleFingerprint"),
            source_boundary=(commit.get("sourceBoundary") if isinstance(commit.get("sourceBoundary"), dict) else {}),
        )
        verified_rows = service.verify_snapshot_run_row_count(
            target,
            snapshot_id=evidence.snapshot_id,
            run_id=run.run_id,
            expected_row_count=expected_count,
        )
        file_count, storage_size = service.table_storage_metrics(target, snapshot_id=evidence.snapshot_id)

        checks = {
            "runSuccess": run.status == "success",
            "airflowSuccess": run.airflow_state == "success",
            "sparkSuccess": spark_result.get("status") == "success",
            "catalogSuccess": catalog_result.get("status") == "success",
            "exactInputRows": int(spark_result.get("inputRows") or -1) == expected_count,
            "exactOutputRows": int(spark_result.get("outputRows") or -1) == expected_count,
            "sourceBoundaryConsistent": boundary == spark_result.get("sourceBoundary") == commit.get("sourceBoundary"),
            "executionIdentityConsistent": execution.get("runId") == run.run_id
            and execution.get("jobId") == job.id
            and bool(execution.get("applicationUid")),
            "sparkTerminal": execution.get("state") == "COMPLETED"
            and execution.get("driverPodPhase") == "Succeeded"
            and execution.get("driverExitCode") == 0,
            "sparkImageMatchesReceipt": str(execution.get("imageDigest") or "").split("@")[-1]
            == expected_image_digest,
            "snapshotPresent": bool(commit.get("snapshotId")),
            "catalogSnapshotMatches": catalog_result.get("icebergSnapshotId") == commit.get("snapshotId"),
            "materializationExactlyOnce": len(materializations) == 1,
            "materializationSnapshotMatches": len(materializations) == 1
            and materializations[0].get("icebergSnapshotId") == commit.get("snapshotId"),
            "queryEngineVerified": spark_result.get("queryEngineVerified") is True,
            "trinoExactRows": verified_rows == expected_count,
            "physicalFilesPresent": file_count > 0 and storage_size > 0,
        }

        if verify_retry:
            before = (
                run.execution_generation,
                execution.get("applicationUid"),
                commit.get("snapshotId"),
                len(materializations),
            )
            retry = execute_airflow_run(db, job.id, run.run_id, "retry", settings.airflow_internal_token)
            db.expire_all()
            next_run = db.get(ETLRunModel, run.run_id)
            next_dataset = db.get(CatalogDatasetModel, job.dataset_id)
            next_states = next_run.task_states or {}
            next_spark = next_states.get("sparkResult") or {}
            next_execution = next_spark.get("kubernetesExecution") or {}
            next_commit = next_spark.get("icebergCommit") or {}
            next_materializations = [
                item
                for item in ((next_dataset.payload or {}).get("materializationRuns") or [])
                if isinstance(item, dict) and item.get("runId") == run.run_id
            ]
            checks.update(
                {
                    "retryReturnedSuccess": retry.status == "success",
                    "retryGenerationStable": next_run.execution_generation == before[0],
                    "retryUidStable": next_execution.get("applicationUid") == before[1],
                    "retrySnapshotStable": next_commit.get("snapshotId") == before[2],
                    "retryMaterializationStable": len(next_materializations) == before[3] == 1,
                }
            )

        result = {
            "contractVersion": "1.0",
            "status": "passed" if all(checks.values()) else "failed",
            "checks": checks,
            "counts": {
                "expectedRows": expected_count,
                "inputRows": int(spark_result.get("inputRows") or -1),
                "outputRows": int(spark_result.get("outputRows") or -1),
                "trinoVerifiedRows": verified_rows,
                "dataFileCount": file_count,
                "materializationCount": len(materializations),
            },
            "privateIdentity": {
                "applicationName": execution.get("applicationName"),
                "applicationUid": execution.get("applicationUid"),
            },
        }
        print(json.dumps(result))
    finally:
        db.close()


if __name__ == "__main__":
    main()
