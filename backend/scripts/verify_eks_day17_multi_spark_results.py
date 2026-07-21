from __future__ import annotations

import json
import re
import sys
from typing import Any, Callable

from sqlalchemy import text

from app.core.database import SessionLocal
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.schemas.iceberg import IcebergWriterTarget
from app.services.iceberg_writer_service import IcebergWriterService


ALIASES = ("Run A", "Run B", "Run C")
EXPECTED_COUNT = 100
RECEIPT_KEYS = (
    "jobId",
    "runId",
    "datasetId",
    "consumerGroup",
    "icebergTable",
    "outputPath",
    "checkpointPath",
    "fixtureBatchId",
)


class Day17ResultVerificationError(RuntimeError):
    pass


def count_value(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return -1
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    digits = re.sub(r"[^0-9]", "", str(value))
    return int(digits) if digits else -1


def receipt_identities(receipt: dict[str, Any]) -> list[dict[str, Any]]:
    identities = receipt.get("privateIdentity")
    if receipt.get("status") != "submitted" or not isinstance(identities, list):
        raise Day17ResultVerificationError("receipt contract is not submitted")
    if len(identities) != len(ALIASES):
        raise Day17ResultVerificationError("receipt must contain exactly three runs")

    by_alias: dict[str, dict[str, Any]] = {}
    for raw_identity in identities:
        if not isinstance(raw_identity, dict):
            raise Day17ResultVerificationError("receipt identity must be an object")
        alias = str(raw_identity.get("alias") or "").strip()
        if alias not in ALIASES or alias in by_alias:
            raise Day17ResultVerificationError("receipt aliases are invalid")
        if any(not str(raw_identity.get(key) or "").strip() for key in RECEIPT_KEYS):
            raise Day17ResultVerificationError("receipt identity is incomplete")
        if count_value(raw_identity.get("expectedCount")) != EXPECTED_COUNT:
            raise Day17ResultVerificationError("receipt expected count is invalid")
        by_alias[alias] = dict(raw_identity)

    if tuple(by_alias) != ALIASES:
        return [by_alias[alias] for alias in ALIASES]
    return list(by_alias.values())


def unique_nonblank(records: list[dict[str, Any]], key: str) -> bool:
    values = [str(record["private"].get(key) or "").strip() for record in records]
    return len(values) == len(ALIASES) and "" not in values and len(set(values)) == len(ALIASES)


def build_sanitized_report(records: list[dict[str, Any]]) -> dict[str, Any]:
    aliases_exact = [record.get("alias") for record in records] == list(ALIASES)
    all_run_checks = len(records) == len(ALIASES) and all(
        all(record.get("checks", {}).values()) for record in records
    )
    unique_checks = {
        "consumerGroupsUnique": unique_nonblank(records, "consumerGroup"),
        "icebergTablesUnique": unique_nonblank(records, "icebergTable"),
        "outputsUnique": unique_nonblank(records, "outputPath"),
        "checkpointsUnique": unique_nonblank(records, "checkpointPath"),
        "snapshotsUnique": unique_nonblank(records, "snapshotId"),
        "datasetsUnique": unique_nonblank(records, "datasetId"),
        "airflowRunsUnique": unique_nonblank(records, "airflowRunId"),
    }
    checks = {
        "exactlyThreeRuns": len(records) == len(ALIASES) and aliases_exact,
        "allRunEvidencePassed": all_run_checks,
        "allStatusesSuccess": len(records) == len(ALIASES)
        and all(record["checks"].get("statusesSuccess") is True for record in records),
        "allSourceBoundariesConsistent": len(records) == len(ALIASES)
        and all(record["checks"].get("sourceBoundaryConsistent") is True for record in records),
        "allMskSparkCountsExact": len(records) == len(ALIASES)
        and all(record["checks"].get("mskSparkCountsExact") is True for record in records),
        "allExactSnapshotsVerified": len(records) == len(ALIASES)
        and all(record["checks"].get("trinoExactSnapshotRows") is True for record in records),
        "allPhysicalDataPresent": len(records) == len(ALIASES)
        and all(record["checks"].get("physicalDataPresent") is True for record in records),
        "allMaterializationsExactlyOnce": len(records) == len(ALIASES)
        and all(record["checks"].get("materializationExactlyOnce") is True for record in records),
        "noResultSubstitution": len(records) == len(ALIASES)
        and all(record["checks"].get("identityChainConsistent") is True for record in records),
        **unique_checks,
    }
    total = lambda key: sum(count_value(record["counts"].get(key)) for record in records)
    report = {
        "contractVersion": "1.0",
        "mode": "read-only",
        "status": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "counts": {
            "runs": len(records),
            "expectedRows": total("expectedRows"),
            "sparkInputRows": total("sparkInputRows"),
            "sparkOutputRows": total("sparkOutputRows"),
            "trinoVerifiedRows": total("trinoVerifiedRows"),
            "dataFiles": total("dataFiles"),
            "materializations": total("materializations"),
            "consumerGroups": len(
                {record["private"]["consumerGroup"] for record in records}
            ),
            "icebergTables": len(
                {record["private"]["icebergTable"] for record in records}
            ),
            "outputs": len({record["private"]["outputPath"] for record in records}),
            "checkpoints": len(
                {record["private"]["checkpointPath"] for record in records}
            ),
            "snapshots": len({record["private"]["snapshotId"] for record in records}),
            "datasets": len({record["private"]["datasetId"] for record in records}),
        },
        "runs": [
            {
                "alias": record["alias"],
                "generation": record["generation"],
                "status": "passed"
                if all(record.get("checks", {}).values())
                else "failed",
                "checks": record["checks"],
                "counts": record["counts"],
            }
            for record in records
        ],
    }
    return report


def collect_run_record(
    db: Any,
    writer: IcebergWriterService,
    identity: dict[str, Any],
) -> dict[str, Any]:
    alias = str(identity["alias"])
    expected_count = count_value(identity["expectedCount"])
    job = db.get(ETLJobModel, str(identity["jobId"]))
    run = db.get(ETLRunModel, str(identity["runId"]))
    if job is None or run is None:
        raise Day17ResultVerificationError("persisted run identity is missing")
    if run.job_id != job.id or str(job.dataset_id or "") != str(identity["datasetId"]):
        raise Day17ResultVerificationError("persisted run identity is inconsistent")
    dataset = db.get(CatalogDatasetModel, str(identity["datasetId"]))
    if dataset is None:
        raise Day17ResultVerificationError("persisted dataset is missing")

    states = run.task_states if isinstance(run.task_states, dict) else {}
    fixture = states.get("eksMvpFixture") if isinstance(states.get("eksMvpFixture"), dict) else {}
    spark = states.get("sparkResult") if isinstance(states.get("sparkResult"), dict) else {}
    catalog = states.get("catalogResult") if isinstance(states.get("catalogResult"), dict) else {}
    execution = (
        spark.get("kubernetesExecution")
        if isinstance(spark.get("kubernetesExecution"), dict)
        else {}
    )
    commit = spark.get("icebergCommit") if isinstance(spark.get("icebergCommit"), dict) else {}
    boundary = fixture.get("sourceBoundary") if isinstance(fixture.get("sourceBoundary"), dict) else {}
    spark_boundary = (
        spark.get("sourceBoundary") if isinstance(spark.get("sourceBoundary"), dict) else {}
    )
    commit_boundary = (
        commit.get("sourceBoundary") if isinstance(commit.get("sourceBoundary"), dict) else {}
    )
    materializations = [
        item
        for item in ((dataset.payload or {}).get("materializationRuns") or [])
        if isinstance(item, dict) and item.get("runId") == run.run_id
    ]

    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    committed_target = IcebergWriterTarget.model_validate(commit.get("target"))
    snapshot_id = str(commit.get("snapshotId") or "").strip()
    evidence = writer.verify_commit(
        target,
        created_table=commit.get("createdTable") is True,
        job_id=job.id,
        run_id=run.run_id,
        expected_snapshot_id=snapshot_id,
        schema_fingerprint=commit.get("schemaFingerprint"),
        rule_fingerprint=commit.get("ruleFingerprint"),
        source_boundary=commit_boundary,
    )
    trino_rows = writer.verify_snapshot_run_row_count(
        target,
        snapshot_id=evidence.snapshot_id,
        run_id=run.run_id,
        expected_row_count=expected_count,
    )
    data_files, storage_size = writer.table_storage_metrics(
        target,
        snapshot_id=evidence.snapshot_id,
    )

    receipt_boundary_matches = all(
        (
            boundary.get("consumerGroup") == identity["consumerGroup"],
            boundary.get("fixtureBatchId") == identity["fixtureBatchId"],
            boundary.get("expectedCount") == expected_count,
            boundary.get("outputPath") == identity["outputPath"],
            boundary.get("checkpointPath") == identity["checkpointPath"],
            fixture.get("icebergTable") == identity["icebergTable"],
            target.table == identity["icebergTable"],
        )
    )
    identity_chain = all(
        (
            fixture.get("runId") == run.run_id,
            boundary.get("snapshotId") == run.run_id,
            run.airflow_dag_run_id == run.run_id,
            execution.get("runId") == run.run_id,
            execution.get("jobId") == job.id,
            commit.get("runId") == run.run_id,
            commit.get("jobId") == job.id,
            catalog.get("runId") == run.run_id,
            catalog.get("datasetId") == dataset.id,
            committed_target == target,
            receipt_boundary_matches,
            len(materializations) == 1,
            len(materializations) == 1
            and materializations[0].get("runId") == run.run_id,
        )
    )
    statuses_success = all(
        (
            run.status == "success",
            run.airflow_state == "success",
            spark.get("status") == "success",
            catalog.get("status") == "success",
            len(materializations) == 1
            and materializations[0].get("status") == "success",
        )
    )
    source_boundary_consistent = (
        bool(boundary)
        and boundary == spark_boundary
        and boundary == commit_boundary
        and receipt_boundary_matches
    )
    input_rows = count_value(spark.get("inputRows"))
    output_rows = count_value(spark.get("outputRows"))
    msk_spark_counts_exact = all(
        (
            boundary.get("expectedCount") == expected_count,
            input_rows == expected_count,
            output_rows == expected_count,
            count_value(run.input_rows) == expected_count,
            count_value(run.output_rows) == expected_count,
        )
    )
    materialization_exactly_once = all(
        (
            len(materializations) == 1,
            len(materializations) == 1
            and materializations[0].get("icebergSnapshotId") == snapshot_id,
            catalog.get("icebergSnapshotId") == snapshot_id,
            count_value(materializations[0].get("rowCount")) == expected_count
            if len(materializations) == 1
            else False,
        )
    )
    checks = {
        "statusesSuccess": statuses_success,
        "sourceBoundaryConsistent": source_boundary_consistent,
        "mskSparkCountsExact": msk_spark_counts_exact,
        "identityChainConsistent": identity_chain,
        "queryEngineVerified": spark.get("queryEngineVerified") is True,
        "trinoExactSnapshotRows": trino_rows == expected_count,
        "physicalDataPresent": data_files > 0 and storage_size > 0,
        "materializationExactlyOnce": materialization_exactly_once,
    }
    return {
        "alias": alias,
        "generation": int(run.execution_generation or 0),
        "checks": checks,
        "counts": {
            "expectedRows": expected_count,
            "sparkInputRows": input_rows,
            "sparkOutputRows": output_rows,
            "trinoVerifiedRows": trino_rows,
            "dataFiles": data_files,
            "storageSizeBytes": storage_size,
            "materializations": len(materializations),
        },
        "private": {
            "consumerGroup": str(identity["consumerGroup"]),
            "icebergTable": target.table,
            "outputPath": str(identity["outputPath"]),
            "checkpointPath": str(identity["checkpointPath"]),
            "snapshotId": snapshot_id,
            "datasetId": dataset.id,
            "airflowRunId": str(run.airflow_dag_run_id or ""),
        },
    }


def verify_receipt(
    receipt: dict[str, Any],
    *,
    session_factory: Callable[[], Any] = SessionLocal,
    writer_factory: Callable[[], IcebergWriterService] = IcebergWriterService,
) -> dict[str, Any]:
    identities = receipt_identities(receipt)
    db = session_factory()
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        writer = writer_factory()
        records = [
            collect_run_record(db, writer, identity)
            for identity in identities
        ]
        return build_sanitized_report(records)
    finally:
        db.close()


def sanitized_failure(exc: Exception) -> dict[str, Any]:
    return {
        "contractVersion": "1.0",
        "mode": "read-only",
        "status": "blocked",
        "errorType": type(exc).__name__,
    }


def main() -> None:
    try:
        receipt = json.load(sys.stdin)
        if not isinstance(receipt, dict):
            raise Day17ResultVerificationError("receipt must be an object")
        report = verify_receipt(receipt)
    except Exception as exc:
        print(json.dumps(sanitized_failure(exc), sort_keys=True))
        raise SystemExit(1) from None
    print(json.dumps(report, sort_keys=True))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
