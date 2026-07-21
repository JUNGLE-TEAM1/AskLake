#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid


BACKEND_DIR = Path(__file__).resolve().parents[1]
IVY_DIR = BACKEND_DIR / "tmp" / "spark-ivy"
SPARK_IMAGE = os.environ.get("ASKLAKE_SPARK_IMAGE", "apache/spark:4.0.1")
PACKAGES = ",".join([
    os.environ.get("ASKLAKE_SPARK_HADOOP_AWS_PACKAGE", "org.apache.hadoop:hadoop-aws:3.4.1"),
    os.environ.get("ASKLAKE_SPARK_ICEBERG_PACKAGE", "org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.11.0"),
    os.environ.get("ASKLAKE_SPARK_POSTGRES_PACKAGE", "org.postgresql:postgresql:42.7.7"),
])
TRINO_CONTAINER = ""


def main() -> None:
    global TRINO_CONTAINER
    if os.environ.get("ASKLAKE_VERIFY_ICEBERG_LIVE", "").lower() not in {"1", "true", "yes", "on"}:
        print("verify-spark-iceberg-batch: skipped (set ASKLAKE_VERIFY_ICEBERG_LIVE=true)")
        return
    require_command("docker")
    IVY_DIR.mkdir(parents=True, exist_ok=True)
    network = container_network("asklake-postgres")
    TRINO_CONTAINER = start_test_trino(network)
    table = f"spark_phase2_{uuid.uuid4().hex[:12]}"
    target = {
        "catalog": "iceberg",
        "namespace": "asklake",
        "partitionColumns": [],
        "table": table,
        "tableUri": f"iceberg://iceberg/asklake/{table}",
        "writeMode": "replace",
    }
    with tempfile.TemporaryDirectory(prefix="asklake-spark-iceberg-") as directory:
        runtime = Path(directory)
        try:
            first = run_spark(runtime, network, target, "run-phase2-first", [{"id": 1}, {"id": 2}])
            assert first["status"] == "success"
            first_snapshot = str(first["icebergCommit"]["snapshotId"])
            assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "2"
            assert trino_current_snapshot(table) == first_snapshot
            assert_spark_file_evidence(first, table, first_snapshot)

            second = run_spark(runtime, network, target, "run-phase2-second", [{"id": 3}])
            assert second["status"] == "success"
            second_snapshot = str(second["icebergCommit"]["snapshotId"])
            assert second_snapshot != first_snapshot
            assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "1"
            assert trino_current_snapshot(table) == second_snapshot
            assert_spark_file_evidence(second, table, second_snapshot)
            assert_quality_failure_preserves_snapshot(
                runtime,
                network,
                target,
                table,
                second_snapshot,
            )

            failed = run_spark(
                runtime,
                network,
                target,
                "run-phase2-rollback",
                [{"id": 4}, {"id": 5}, {"id": 6}],
                fail_after_commit=True,
                expect_success=False,
            )
            assert failed["status"] == "failed"
            assert failed["failedStage"] == "Iceberg commit"
            current_snapshot = trino_current_snapshot(table)
            if current_snapshot != second_snapshot:
                refs = trino_execute(f'SELECT * FROM iceberg.asklake."{table}$refs"')
                history = trino_execute(f'SELECT * FROM iceberg.asklake."{table}$history"')
                raise AssertionError(
                    f"rollback snapshot mismatch: expected={second_snapshot}, actual={current_snapshot}, "
                    f"error={failed.get('error')!r}\nrefs:\n{refs}\nhistory:\n{history}"
                )
            assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "1"

            third = run_spark(runtime, network, target, "run-phase2-after-rollback", [{"id": 7}, {"id": 8}])
            assert third["status"] == "success"
            third_snapshot = str(third["icebergCommit"]["snapshotId"])
            assert third_snapshot not in {first_snapshot, second_snapshot}
            assert trino_current_snapshot(table) == third_snapshot
            assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "2"
            assert_spark_file_evidence(third, table, third_snapshot)
            assert int(trino_snapshot_file_count(table, second_snapshot)) > 0
            assert int(trino_snapshot_file_count(table, third_snapshot)) > 0
            assert int(trino_snapshot_file_size(table, second_snapshot)) > 0
            assert int(trino_snapshot_file_size(table, third_snapshot)) > 0

            failed_again = run_spark(
                runtime,
                network,
                target,
                "run-phase2-second-rollback",
                [{"id": 9}],
                fail_after_commit=True,
                expect_success=False,
            )
            assert failed_again["status"] == "failed"
            assert trino_current_snapshot(table) == third_snapshot
            assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "2"
        finally:
            trino_execute(f'DROP TABLE IF EXISTS iceberg.asklake."{table}"', check=False)
            stop_test_trino(TRINO_CONTAINER)
    print("verify-spark-iceberg-batch: ok")


def assert_quality_failure_preserves_snapshot(
    runtime: Path,
    network: str,
    target: dict,
    table: str,
    expected_snapshot: str,
) -> None:
    snapshot_count = int(trino_snapshot_count(table))
    failed = run_spark(
        runtime,
        network,
        target,
        "run-phase2-quality-failure",
        [{"id": -1}],
        quality_rules=[{
            "enabled": True,
            "failureAction": "Fail Run",
            "id": "positive-id",
            "kind": "range",
            "severity": "Error",
            "targetColumn": "id",
            "validationType": "Range Check",
        }],
        expect_success=False,
    )
    assert failed["status"] == "failed"
    assert failed["failedStage"] == "Quality"
    assert failed.get("icebergCommit") is None
    assert (failed.get("outputCleanup") or {}).get("status") == "success"
    assert (failed.get("sparkResources") or {}).get("materializationCleanupStatus") == "success"
    assert trino_current_snapshot(table) == expected_snapshot
    assert int(trino_snapshot_count(table)) == snapshot_count
    assert trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}"') == "1"


def assert_spark_file_evidence(result: dict, table: str, snapshot_id: str) -> None:
    exact_file_count = int(trino_snapshot_file_count(table, snapshot_id))
    assert exact_file_count > 0
    assert int(result["outputFileCount"]) == exact_file_count, result
    assert int(result["icebergCommit"]["dataFileCount"]) == exact_file_count, result
    phase_timings = result.get("phaseTimings")
    assert isinstance(phase_timings, dict), result
    for phase in (
        "sourceValidation",
        "materializationStaging",
        "qualityAggregation",
        "sourcePostValidation",
        "targetPublish",
    ):
        assert int((phase_timings.get(phase) or {}).get("durationMs") or 0) >= 0, phase_timings
    spark_resources = result.get("sparkResources") or {}
    assert spark_resources.get("cacheStorageLevel") == "NONE", spark_resources
    assert spark_resources.get("materializationMode") == "run_scoped_parquet_staging", spark_resources
    assert int(spark_resources.get("materializationFileCount") or 0) > 0, spark_resources
    assert spark_resources.get("materializationCleanupStatus") == "success", spark_resources
    assert spark_resources.get("outputFrameCacheMode") == "staged_parquet_reuse", spark_resources


def run_spark(
    runtime: Path,
    network: str,
    target: dict,
    run_id: str,
    rows: list[dict],
    *,
    fail_after_commit: bool = False,
    expect_success: bool = True,
    quality_rules: list[dict] | None = None,
) -> dict:
    source = runtime / f"{run_id}.jsonl"
    report = runtime / f"{run_id}.report.json"
    manifest = runtime / f"{run_id}.manifest.json"
    source.write_text("".join(f"{json.dumps(row)}\n" for row in rows), encoding="utf-8")
    manifest.write_text(json.dumps({
        "icebergTarget": target,
        "jobId": "JOB-PHASE2-LIVE",
        "partitionColumns": [],
        "qualityRules": quality_rules or [],
        "ruleFingerprint": "rules-phase2-live",
        "schemaColumns": [{
            "included": True,
            "nullable": False,
            "sourceName": "id",
            "targetName": "id",
            "type": "Long",
        }],
        "schemaFingerprint": "schema-phase2-live",
        "sourceCollection": {"mode": "full", "scope": "file"},
        "transformSteps": [],
    }), encoding="utf-8")
    command = [
        "docker", "run", "--rm", "--network", network,
        "-v", f"{BACKEND_DIR / 'scripts'}:/work/scripts:ro",
        "-v", f"{IVY_DIR}:/tmp/.ivy2",
        "-v", f"{runtime}:/work/runtime",
        "-e", f"ASKLAKE_SPARK_SOURCE_PATH=file:///work/runtime/{source.name}",
        "-e", "ASKLAKE_SPARK_SOURCE_FORMAT=jsonl",
        "-e", f"ASKLAKE_SPARK_OUTPUT_PATH=file:///work/runtime/{run_id}-artifacts",
        "-e", f"ASKLAKE_SPARK_RUN_ID={run_id}",
        "-e", f"ASKLAKE_SPARK_JOB_MANIFEST_FILE=/work/runtime/{manifest.name}",
        "-e", f"ASKLAKE_SPARK_REPORT_FILE=/work/runtime/{report.name}",
        "-e", "ASKLAKE_OBJECT_STORAGE_PROVIDER=minio",
        "-e", "MINIO_ENDPOINT=http://minio:9000",
        "-e", "MINIO_ACCESS_KEY=m3admin",
        "-e", "MINIO_SECRET_KEY=wishuponastar",
        "-e", "ASKLAKE_SPARK_ICEBERG_CATALOG_NAME=asklake",
        "-e", "ASKLAKE_SPARK_ICEBERG_JDBC_URL=jdbc:postgresql://postgres:5432/asklake",
        "-e", "ASKLAKE_SPARK_ICEBERG_JDBC_USER=asklake",
        "-e", "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD=asklake_dev",
        "-e", "ASKLAKE_SPARK_ICEBERG_WAREHOUSE=s3a://asklake-warehouse/warehouse",
        "-e", f"ASKLAKE_SPARK_FAIL_AFTER_ICEBERG_COMMIT={'true' if fail_after_commit else 'false'}",
        "-e", "HOME=/tmp",
        SPARK_IMAGE,
        "/opt/spark/bin/spark-submit",
        "--master", "local[2]",
        "--conf", "spark.jars.ivy=/tmp/.ivy2",
        "--packages", PACKAGES,
        "/work/scripts/spark_job_run.py",
    ]
    completed = subprocess.run(command, text=True, capture_output=True, timeout=600)
    if expect_success and completed.returncode != 0:
        raise RuntimeError(f"Spark live run failed:\n{completed.stdout[-4000:]}\n{completed.stderr[-4000:]}")
    if not report.exists():
        raise RuntimeError(f"Spark live run did not write a report:\n{completed.stdout[-4000:]}\n{completed.stderr[-4000:]}")
    payload = json.loads(report.read_text(encoding="utf-8"))
    if expect_success != (payload.get("status") == "success"):
        raise AssertionError(payload)
    return payload


def container_network(container: str) -> str:
    output = subprocess.check_output([
        "docker", "inspect", "-f", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{\"\\n\"}}{{end}}", container,
    ], text=True)
    network = next((line.strip() for line in output.splitlines() if line.strip()), "")
    if not network:
        raise RuntimeError(f"No Docker network found for {container}")
    return network


def trino_current_snapshot(table: str) -> str:
    return trino_scalar(
        f'SELECT snapshot_id FROM iceberg.asklake."{table}$refs" '
        "WHERE name = 'main' LIMIT 1"
    )


def trino_snapshot_file_count(table: str, snapshot_id: str) -> str:
    return trino_snapshot_summary_metric(table, snapshot_id, "total-data-files")


def trino_snapshot_file_size(table: str, snapshot_id: str) -> str:
    return trino_snapshot_summary_metric(table, snapshot_id, "total-files-size")


def trino_snapshot_count(table: str) -> str:
    return trino_scalar(f'SELECT count(*) FROM iceberg.asklake."{table}$snapshots"')


def trino_snapshot_summary_metric(table: str, snapshot_id: str, metric: str) -> str:
    return trino_scalar(
        f"SELECT TRY_CAST(element_at(summary, '{metric}') AS BIGINT) "
        f'FROM iceberg.asklake."{table}$snapshots" '
        f"WHERE snapshot_id = {int(snapshot_id)} LIMIT 1"
    )


def trino_scalar(query: str) -> str:
    output = trino_execute(query)
    lines = [line.strip().strip('"') for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def trino_execute(query: str, *, check: bool = True) -> str:
    completed = subprocess.run([
        "docker", "exec", TRINO_CONTAINER, "trino",
        "--output-format", "CSV_HEADER_UNQUOTED",
        "--execute", query,
    ], text=True, capture_output=True, timeout=120)
    if check and completed.returncode != 0:
        raise RuntimeError(f"Trino query failed: {completed.stderr or completed.stdout}")
    return completed.stdout


def start_test_trino(network: str) -> str:
    container = f"asklake-phase2-trino-{uuid.uuid4().hex[:8]}"
    catalog_dir = BACKEND_DIR.parent / "deploy" / "trino" / "etc" / "catalog"
    command = [
        "docker", "run", "-d", "--rm", "--name", container, "--network", network,
        "-e", "TRINO_ICEBERG_CATALOG_NAME=asklake",
        "-e", "TRINO_ICEBERG_JDBC_DATABASE=asklake",
        "-e", "TRINO_ICEBERG_JDBC_PASSWORD=asklake_dev",
        "-e", "TRINO_ICEBERG_JDBC_USER=asklake",
        "-e", "TRINO_ICEBERG_WAREHOUSE_BUCKET=asklake-warehouse",
        "-e", "TRINO_ICEBERG_WAREHOUSE_PREFIX=warehouse",
        "-e", "TRINO_S3_ACCESS_KEY=m3admin",
        "-e", "TRINO_S3_ENDPOINT=http://minio:9000",
        "-e", "TRINO_S3_REGION=us-east-1",
        "-e", "TRINO_S3_SECRET_KEY=wishuponastar",
        "-v", f"{catalog_dir}:/etc/trino/catalog:ro",
        os.environ.get("TRINO_IMAGE", "trinodb/trino:482"),
    ]
    completed = subprocess.run(command, text=True, capture_output=True, timeout=60)
    if completed.returncode != 0:
        raise RuntimeError(f"Test Trino could not start: {completed.stderr or completed.stdout}")
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        probe = subprocess.run(
            ["docker", "exec", container, "trino", "--execute", "SHOW CATALOGS"],
            text=True,
            capture_output=True,
            timeout=20,
        )
        if probe.returncode == 0 and "iceberg" in probe.stdout:
            return container
        time.sleep(2)
    logs = subprocess.run(
        ["docker", "logs", "--tail", "200", container],
        text=True,
        capture_output=True,
    )
    stop_test_trino(container)
    raise RuntimeError(f"Test Trino did not become ready: {logs.stdout or logs.stderr}")


def stop_test_trino(container: str) -> None:
    if container:
        subprocess.run(
            ["docker", "rm", "-f", container],
            text=True,
            capture_output=True,
            timeout=30,
        )


def require_command(command: str) -> None:
    if shutil.which(command) is None:
        raise RuntimeError(f"Required command is not installed: {command}")


if __name__ == "__main__":
    main()
