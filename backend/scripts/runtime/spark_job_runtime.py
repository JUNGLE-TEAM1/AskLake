import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T

from object_storage_runtime import configure_spark_builder
from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules
from spark_snapshot_rules import apply_spark_snapshot_rules, supports_spark_snapshot_rules
from spark_source_identity import (
    source_change_detection_mode,
    verify_incremental_source_inventory,
)
from runtime.contracts import (
    append_secondary_error,
    load_json_env,
    load_spark_job_manifest,
    now_iso,
    required_env,
    write_report,
)
from runtime.config import SparkJobConfig
from runtime.spark_iceberg_identifiers import (
    quote_spark_identifier,
    required_iceberg_identifier,
    spark_iceberg_source_identifier,
)
from runtime.spark_text_analysis import *  # noqa: F403 - compatibility re-export façade.


class IcebergCommitError(RuntimeError):
    failed_stage = "Iceberg commit"


def main():
    started_at = now_iso()
    started_ms = int(time.time() * 1000)
    report_file = os.environ.get("ASKLAKE_SPARK_REPORT_FILE")
    source_path = os.environ.get("ASKLAKE_SPARK_SOURCE_PATH", "-")
    source_format = os.environ.get("ASKLAKE_SPARK_SOURCE_FORMAT", "unknown").lower()
    output_path = os.environ.get("ASKLAKE_SPARK_OUTPUT_PATH", "-")
    run_id = os.environ.get("ASKLAKE_SPARK_RUN_ID", "unknown")
    source_collection = {}
    spark = None
    input_bytes = 0
    input_file_count = 0
    staging_path = None
    output_write_started = False
    input_rows = 0
    output_file_count = 0
    quality = None
    transform = None
    canonical_snapshot = False
    iceberg_commit = None
    iceberg_previous_snapshot = None
    try:
        config = SparkJobConfig.from_environment()
        source_path = config.source_path
        source_format = config.source_format
        output_path = config.output_path
        run_id = config.run_id
        row_limit = config.row_limit
        manifest = config.manifest
        iceberg_target = parse_iceberg_target(manifest.get("icebergTarget"))
        partition_columns = parse_partition_columns(
            manifest.get("partitionColumns") or os.environ.get("ASKLAKE_SPARK_PARTITION_COLUMNS")
        )
        schema_columns = manifest.get("schemaColumns") or load_json_env("ASKLAKE_SPARK_SCHEMA_COLUMNS", [])
        source_collection = manifest.get("sourceCollection") or {}
        source_boundary = manifest.get("sourceBoundary") or source_collection
        record_parsing = manifest.get("recordParsing") or {}
        transform_steps = manifest.get("transformSteps") or load_json_env("ASKLAKE_SPARK_TRANSFORM_STEPS", [])
        quality_rules = manifest.get("qualityRules") or load_json_env("ASKLAKE_SPARK_QUALITY_RULES", [])
        canonical_rules = manifest.get("rules") if "rules" in manifest else None
        canonical_snapshot = manifest.get("ruleContractVersion") == "1.0" and canonical_rules is not None
        canonical_runtime_supported = canonical_snapshot and supports_spark_snapshot_rules(canonical_rules)
        final_schema_columns = merge_rule_output_schema(schema_columns, manifest.get("ruleOutputSchema") or [])
        spark = make_spark(source_collection, iceberg_target)
        verify_spark_source_inventory(
            spark,
            source_path,
            source_collection,
            phase="before_read",
        )
        source_df = read_source(
            spark,
            source_format,
            source_path,
            schema_columns,
            record_parsing,
            source_collection,
            transform_steps,
        )
        input_files = sorted(source_df.inputFiles())
        input_file_count = len(input_files) or int(source_collection.get("expectedFileCount") or 0)
        input_bytes = source_file_bytes(spark, input_files) if input_files else int(
            source_collection.get("expectedTotalBytes") or 0
        )
        working_df = source_df if row_limit <= 0 else source_df.limit(row_limit)
        normalized_df = normalize_columns(working_df, schema_columns, transform_steps)
        contracted_df, input_rows = apply_schema_contract_with_count(
            normalized_df,
            schema_columns,
            transform_steps,
        )
        review_analysis_preflight = plan_review_row_analysis_checks(transform_steps)
        blocking_text_model_checks = [
            check
            for check in review_analysis_preflight
            if check.get("runtimeStatus") == "missing_model_artifact" and check.get("modelRequired")
        ]
        if blocking_text_model_checks:
            ended_at = now_iso()
            quality = {
                "blockingFailures": len(blocking_text_model_checks),
                "failedRules": [],
                "invalidRows": input_rows,
                "passRate": 0.0,
                "reviewRowAnalysisChecks": review_analysis_preflight,
                "sampleRows": input_rows,
                "score": 0.0,
                "status": "fail",
                "summary": "Text structuring requires a trained compatible model for one or more columns.",
            }
            text_structuring = text_structuring_manifest(transform_steps, review_analysis_preflight)
            quality["textStructuringExecution"] = text_structuring.get("execution", {})
            result = {
                "durationMs": int(time.time() * 1000) - started_ms,
                "endedAt": ended_at,
                "error": quality["summary"],
                "failedStage": "Text Structuring Model Selection",
                "format": source_format,
                "inputBytes": input_bytes,
                "inputFileCount": input_file_count,
                "inputRows": input_rows,
                "outputFileCount": 0,
                "outputPath": output_path,
                "outputRows": 0,
                "quality": quality,
                "runId": run_id,
                "sourceCollection": source_collection,
                "sourcePath": source_path,
                "startedAt": started_at,
                "status": "failed",
                "textStructuring": text_structuring,
            }
            write_report(report_file, result)
            print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
            return 1
        quarantine_df = None
        review_analysis_checks = []
        transform = None
        if canonical_runtime_supported:
            execution = apply_spark_snapshot_rules(
                spark,
                contracted_df,
                canonical_rules,
                input_row_count=input_rows,
            )
            transformed_df = execution["frame"]
            transform = execution["transform"]
            quality = snapshot_quality_report(execution["quality"])
            quarantine_df = execution["quarantine"]
        elif canonical_snapshot:
            transformed_df = apply_transform_steps(spark, contracted_df, transform_steps)
            canonical_quality_rules = [
                rule for rule in canonical_rules
                if rule and rule.get("kind") == "quality" and rule.get("enabled") is not False
            ]
            quality_execution = apply_snapshot_rules(transformed_df, canonical_quality_rules)
            transformed_df = quality_execution["frame"]
            quality = snapshot_quality_report(quality_execution["quality"])
            quarantine_df = quality_execution["quarantine"]
        else:
            transformed_df = apply_transform_steps(spark, contracted_df, transform_steps)
        output_frame = select_final_schema_columns(transformed_df, final_schema_columns)
        output_df = output_frame.withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
            "_asklake_ingested_at",
            F.current_timestamp(),
        )
        kafka_snapshot_id = kafka_snapshot_boundary_id(source_boundary)
        if kafka_snapshot_id:
            output_df = output_df.withColumn(
                "_asklake_kafka_snapshot_id",
                F.lit(kafka_snapshot_id),
            )
        resolved_partition_columns = resolve_partition_columns(output_df, partition_columns)
        if iceberg_target and iceberg_target["partitionColumns"] != resolved_partition_columns:
            raise ValueError(
                "ICEBERG_PARTITION_CONTRACT_MISMATCH "
                f"expected={iceberg_target['partitionColumns']} resolved={resolved_partition_columns}"
            )
        staging_path = spark_staging_path(output_path, run_id)
        delete_spark_path(spark, staging_path)
        quarantine_staging_path = f"{staging_path}_quarantine"
        if quarantine_df is not None:
            quarantine_rows = quarantine_df.count()
            if quarantine_rows:
                quarantine_df.write.mode("overwrite").parquet(quarantine_staging_path)
                quality["quarantine"] = {"count": quarantine_rows, "path": f"{output_path.rstrip('/')}_quarantine"}
                quality["quarantineLocation"] = f"{output_path.rstrip('/')}_quarantine"
        write_df = output_df
        if source_collection.get("selectionKind") == "prefix" and input_file_count > 1:
            max_partitions = max(2, int(os.environ.get("ASKLAKE_SPARK_PREFIX_OUTPUT_PARTITIONS_MAX", "32") or "32"))
            write_df = output_df.repartition(min(input_file_count, max_partitions))
        if iceberg_target:
            written_df = write_df.persist()
            output_rows = written_df.count()
        else:
            writer = write_df.write.mode("overwrite")
            if resolved_partition_columns:
                writer = writer.partitionBy(*resolved_partition_columns)
            output_write_started = True
            writer.parquet(staging_path)
            written_df = spark.read.parquet(staging_path)
            output_file_count = len(written_df.inputFiles())
            output_rows = written_df.count()
        if not canonical_snapshot:
            quality = evaluate_quality_rules(written_df, quality_rules, total_rows=output_rows)
            classifier_checks = evaluate_custom_csv_classifier_checks(written_df, transform_steps, total_rows=output_rows)
            if classifier_checks:
                quality["classifierChecks"] = classifier_checks
            review_analysis_checks = evaluate_review_row_analysis_checks(written_df, transform_steps, total_rows=output_rows)
            if review_analysis_checks:
                quality["reviewRowAnalysisChecks"] = review_analysis_checks
                merge_text_structuring_quality(quality, written_df, review_analysis_checks, staging_path, total_rows=output_rows)
        text_structuring = text_structuring_manifest(transform_steps, review_analysis_checks)
        if text_structuring.get("definition", {}).get("columns"):
            quality["textStructuringExecution"] = text_structuring.get("execution", {})
        sample_rows = collect_sample_rows(written_df, 10)
        verify_spark_source_inventory(
            spark,
            source_path,
            source_collection,
            phase="after_read",
        )
        if quality["status"] == "fail":
            cleanup_errors = cleanup_failed_output_paths(spark, staging_path)
            ended_at = now_iso()
            result = {
                "durationMs": int(time.time() * 1000) - started_ms,
                "endedAt": ended_at,
                "error": quality["summary"],
                "failedStage": "Quality",
                "format": source_format,
                "inputBytes": input_bytes,
                "inputFileCount": input_file_count,
                "inputRows": input_rows,
                "outputFileCount": output_file_count,
                "outputPath": output_path,
                "outputRows": output_rows,
                "outputCleanup": {
                    "errors": cleanup_errors,
                    "status": "failed" if cleanup_errors else "success",
                },
                "quality": quality,
                "runId": run_id,
                "sampleRows": sample_rows,
                "schema": [
                    {
                        "name": field.name,
                        "nullable": field.nullable,
                        "type": field.dataType.simpleString(),
                    }
                    for field in output_df.schema.fields
                ],
                "sourcePath": source_path,
                "sourceCollection": source_collection,
                "startedAt": started_at,
                "status": "failed",
                "textStructuring": text_structuring,
                "transform": transform,
            }
            write_report(report_file, result)
            print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
            return 1
        published_output_path = output_path
        if iceberg_target:
            output_write_started = True
            iceberg_commit = commit_iceberg_table(
                spark,
                written_df,
                iceberg_target,
                job_id=str(manifest.get("jobId") or "unknown"),
                run_id=run_id,
                partition_columns=resolved_partition_columns,
                schema_fingerprint=manifest.get("schemaFingerprint"),
                rule_fingerprint=manifest.get("ruleFingerprint"),
                source_boundary=source_boundary,
            )
            iceberg_previous_snapshot = iceberg_commit.pop("_previousSnapshot", None)
            publish_spark_quarantine(spark, quarantine_staging_path, output_path)
            published_output_path = iceberg_commit["target"]["tableUri"]
            output_file_count = iceberg_output_file_count(spark, iceberg_target)
        else:
            publish_spark_paths(spark, staging_path, output_path, quarantine_staging_path)
            written_df = spark.read.parquet(output_path)
            output_file_count = len(written_df.inputFiles())
            output_rows = written_df.count()
        ended_at = now_iso()
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "format": source_format,
            "inputBytes": input_bytes,
            "inputFileCount": input_file_count,
            "inputRows": input_rows,
            "outputFileCount": output_file_count,
            "outputPath": published_output_path,
            "outputRows": output_rows,
            "quality": quality,
            "runId": run_id,
            "sampleRows": sample_rows,
            "schema": [
                {
                    "name": field.name,
                    "nullable": field.nullable,
                    "type": field.dataType.simpleString(),
                }
                for field in output_df.schema.fields
            ],
            "sourcePath": source_path,
            "sourceCollection": source_collection,
            "sourceBoundary": source_boundary,
            "startedAt": started_at,
            "status": "success",
            "textStructuring": text_structuring,
            "transform": transform,
        }
        if iceberg_commit:
            result["icebergCommit"] = iceberg_commit
            result["warehouseLocation"] = iceberg_commit["warehouseLocation"]
        write_report(report_file, result)
        print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
        return 0
    except Exception as exc:
        if spark is not None and iceberg_commit is not None:
            try:
                rollback_iceberg_commit(spark, iceberg_target, iceberg_previous_snapshot)
            except Exception as rollback_exc:
                exc = IcebergCommitError(f"{exc}; rollback failed: {rollback_exc}")
            else:
                exc = IcebergCommitError(str(exc))
        ended_at = now_iso()
        cleanup_errors = (
            cleanup_failed_output_paths(spark, staging_path or output_path)
            if spark is not None and output_write_started
            else []
        )
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "error": str(exc),
            "failedStage": getattr(
                exc,
                "failed_stage",
                "Record Parsing"
                if "RECORD_FIELD_COUNT_MISMATCH" in str(exc) or "RECORD_PARSING_" in str(exc)
                else "Source Inventory"
                if "SOURCE_OBJECT_" in str(exc)
                else "Spark ETL",
            ),
            "format": source_format,
            "inputBytes": input_bytes,
            "inputFileCount": input_file_count,
            "inputRows": input_rows,
            "outputFileCount": output_file_count,
            "outputPath": output_path,
            "outputRows": 0,
            "runId": run_id,
            "sourceCollection": source_collection,
            "sourcePath": source_path,
            "startedAt": started_at,
            "status": "failed",
        }
        error_quality = getattr(exc, "quality", None) or quality
        if error_quality is not None:
            result["quality"] = snapshot_quality_report(error_quality) if canonical_snapshot else error_quality
        error_transform = getattr(exc, "transform", None) or transform
        if error_transform is not None:
            result["transform"] = error_transform
        if output_write_started:
            result["outputCleanup"] = {
                "errors": cleanup_errors,
                "status": "failed" if cleanup_errors else "success",
            }
        try:
            write_report(report_file, result)
        except OSError as report_error:
            append_secondary_error(result, report_error, stage="runtime_report")
        print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
        print(f"Spark job failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if spark is not None:
            spark.stop()


def spark_staging_path(output_path, run_id):
    safe_run_id = re.sub(r"[^0-9A-Za-z_-]+", "_", str(run_id or "run")).strip("_") or "run"
    return f"{str(output_path).rstrip('/')}.__staging__{safe_run_id}"


def delete_spark_path(spark, path_value):
    path = spark.sparkContext._jvm.org.apache.hadoop.fs.Path(path_value)
    filesystem = path.getFileSystem(spark.sparkContext._jsc.hadoopConfiguration())
    if filesystem.exists(path) and not filesystem.delete(path, True):
        raise RuntimeError(f"Could not delete Spark path: {path_value}")


def publish_spark_paths(spark, staging_path, output_path, quarantine_staging_path):
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    staging = jvm.org.apache.hadoop.fs.Path(staging_path)
    target = jvm.org.apache.hadoop.fs.Path(output_path)
    quarantine_staging = jvm.org.apache.hadoop.fs.Path(quarantine_staging_path)
    quarantine_target = jvm.org.apache.hadoop.fs.Path(f"{output_path.rstrip('/')}_quarantine")
    filesystem = staging.getFileSystem(hadoop)
    if not filesystem.exists(staging):
        raise RuntimeError(f"Spark staging output is missing: {staging_path}")
    suffix = f".__previous__{re.sub(r'[^0-9A-Za-z_-]+', '_', str(os.environ.get('ASKLAKE_SPARK_RUN_ID') or 'run'))}"
    target_backup = jvm.org.apache.hadoop.fs.Path(f"{output_path.rstrip('/')}{suffix}")
    quarantine_backup = jvm.org.apache.hadoop.fs.Path(f"{output_path.rstrip('/')}_quarantine{suffix}")
    moved_target = False
    moved_quarantine = False
    published_target = False
    try:
        for backup in (target_backup, quarantine_backup):
            if filesystem.exists(backup) and not filesystem.delete(backup, True):
                raise RuntimeError(f"Could not remove stale Spark backup: {backup}")
        if filesystem.exists(target) and not filesystem.rename(target, target_backup):
            raise RuntimeError(f"Could not stage previous Spark target: {output_path}")
        moved_target = True
        if filesystem.exists(quarantine_target) and not filesystem.rename(quarantine_target, quarantine_backup):
            raise RuntimeError(f"Could not stage previous Spark quarantine: {quarantine_target}")
        moved_quarantine = True
        if not filesystem.rename(staging, target):
            raise RuntimeError(f"Could not publish Spark staging output: {staging_path} -> {output_path}")
        published_target = True
        if filesystem.exists(quarantine_staging) and not filesystem.rename(quarantine_staging, quarantine_target):
            raise RuntimeError(f"Could not publish Spark quarantine: {quarantine_staging} -> {quarantine_target}")
        for backup in (target_backup, quarantine_backup):
            if filesystem.exists(backup) and not filesystem.delete(backup, True):
                raise RuntimeError(f"Could not remove published Spark backup: {backup}")
    except Exception:
        if published_target and filesystem.exists(target):
            filesystem.delete(target, True)
        if moved_target and filesystem.exists(target_backup):
            filesystem.rename(target_backup, target)
        if moved_quarantine and filesystem.exists(quarantine_backup):
            filesystem.rename(quarantine_backup, quarantine_target)
        raise


def publish_spark_quarantine(spark, quarantine_staging_path, output_path):
    jvm = spark.sparkContext._jvm
    hadoop = spark.sparkContext._jsc.hadoopConfiguration()
    staging = jvm.org.apache.hadoop.fs.Path(quarantine_staging_path)
    target = jvm.org.apache.hadoop.fs.Path(f"{output_path.rstrip('/')}_quarantine")
    filesystem = staging.getFileSystem(hadoop)
    if not filesystem.exists(staging):
        return
    backup = jvm.org.apache.hadoop.fs.Path(
        f"{output_path.rstrip('/')}_quarantine.__previous__{safe_identifier(os.environ.get('ASKLAKE_SPARK_RUN_ID') or 'run')}"
    )
    moved_target = False
    try:
        if filesystem.exists(backup) and not filesystem.delete(backup, True):
            raise RuntimeError(f"Could not remove stale Spark quarantine backup: {backup}")
        if filesystem.exists(target) and not filesystem.rename(target, backup):
            raise RuntimeError(f"Could not stage previous Spark quarantine: {target}")
        moved_target = True
        if not filesystem.rename(staging, target):
            raise RuntimeError(f"Could not publish Spark quarantine: {staging} -> {target}")
        if filesystem.exists(backup) and not filesystem.delete(backup, True):
            raise RuntimeError(f"Could not remove published Spark quarantine backup: {backup}")
    except Exception:
        if moved_target and filesystem.exists(backup):
            if filesystem.exists(target):
                filesystem.delete(target, True)
            filesystem.rename(backup, target)
        raise


def parse_iceberg_target(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("ICEBERG_TARGET_INVALID expected an object")
    target = {
        "catalog": required_iceberg_identifier(value.get("catalog"), "catalog"),
        "namespace": required_iceberg_identifier(value.get("namespace"), "namespace"),
        "table": required_iceberg_identifier(value.get("table"), "table"),
        "writeMode": str(value.get("writeMode") or "").strip().lower(),
        "partitionColumns": parse_partition_columns(value.get("partitionColumns")),
    }
    if target["writeMode"] not in {"append", "replace"}:
        raise ValueError("ICEBERG_TARGET_INVALID writeMode must be append or replace")
    target["tableUri"] = str(
        value.get("tableUri")
        or f"iceberg://{target['catalog']}/{target['namespace']}/{target['table']}"
    )
    expected_uri = f"iceberg://{target['catalog']}/{target['namespace']}/{target['table']}"
    if target["tableUri"] != expected_uri:
        raise ValueError("ICEBERG_TARGET_INVALID tableUri does not match catalog identity")
    return target


def safe_identifier(value):
    return re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "value")).strip("_") or "value"


def spark_iceberg_catalog_name():
    return required_iceberg_identifier(
        os.environ.get("ASKLAKE_SPARK_ICEBERG_CATALOG_NAME") or "asklake",
        "sparkCatalog",
    )


def spark_iceberg_table_identifier(target):
    return ".".join(
        quote_spark_identifier(item)
        for item in (spark_iceberg_catalog_name(), target["namespace"], target["table"])
    )


def iceberg_table_exists(spark, target):
    try:
        spark.table(spark_iceberg_table_identifier(target)).schema
        return True
    except Exception as exc:
        if "TABLE_OR_VIEW_NOT_FOUND" in str(exc) or "NoSuchTableException" in str(exc):
            return False
        raise


def iceberg_snapshot(spark, target, snapshot_id):
    table_identifier = spark_iceberg_table_identifier(target)
    rows = spark.sql(
        "SELECT CAST(snapshot_id AS STRING) AS snapshot_id, "
        "CAST(committed_at AS STRING) AS committed_at, manifest_list "
        f"FROM {table_identifier}.snapshots "
        f"WHERE CAST(snapshot_id AS STRING) = '{str(snapshot_id).replace(chr(39), chr(39) * 2)}' "
        "LIMIT 1"
    ).collect()
    if not rows:
        raise RuntimeError("ICEBERG_SNAPSHOT_EVIDENCE_MISSING")
    row = rows[0]
    snapshot_id = str(row["snapshot_id"] or "").strip()
    committed_at = str(row["committed_at"] or "").strip()
    warehouse_location = warehouse_location_from_manifest(row["manifest_list"])
    if not snapshot_id or not committed_at or not warehouse_location:
        raise RuntimeError("ICEBERG_SNAPSHOT_EVIDENCE_INCOMPLETE")
    return {
        "committedAt": committed_at,
        "snapshotId": snapshot_id,
        "warehouseLocation": warehouse_location,
    }


def current_iceberg_snapshot(spark, target):
    return iceberg_snapshot(spark, target, current_iceberg_snapshot_id(spark, target))


def iceberg_output_file_count(spark, target):
    return len(spark.table(spark_iceberg_table_identifier(target)).inputFiles())


def latest_iceberg_snapshot(spark, target):
    """Compatibility alias; commit state must follow the current main ref."""
    return current_iceberg_snapshot(spark, target)


def current_iceberg_snapshot_id(spark, target):
    table_identifier = spark_iceberg_table_identifier(target)
    rows = spark.sql(
        "SELECT CAST(snapshot_id AS STRING) AS snapshot_id "
        f"FROM {table_identifier}.refs WHERE name = 'main' LIMIT 1"
    ).collect()
    if not rows or not str(rows[0]["snapshot_id"] or "").strip():
        raise RuntimeError("ICEBERG_CURRENT_SNAPSHOT_EVIDENCE_MISSING")
    return str(rows[0]["snapshot_id"]).strip()


def warehouse_location_from_manifest(value):
    manifest_list = str(value or "").strip()
    marker = "/metadata/"
    return manifest_list.split(marker, 1)[0].rstrip("/") if marker in manifest_list else ""


def commit_iceberg_table(
    spark,
    frame,
    target,
    *,
    job_id,
    run_id,
    partition_columns,
    schema_fingerprint,
    rule_fingerprint,
    source_boundary,
):
    spark_catalog = quote_spark_identifier(spark_iceberg_catalog_name())
    namespace = quote_spark_identifier(target["namespace"])
    table_identifier = spark_iceberg_table_identifier(target)
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {spark_catalog}.{namespace}")
    existed_before = iceberg_table_exists(spark, target)
    previous_snapshot = latest_iceberg_snapshot(spark, target) if existed_before else None
    effective_write_mode = target["writeMode"]
    if effective_write_mode == "append" and bool((source_boundary or {}).get("rebaseline")):
        effective_write_mode = "replace"
    if (
        effective_write_mode == "append"
        and existed_before
        and iceberg_source_boundary_exists(spark, target, source_boundary)
    ):
        snapshot = latest_iceberg_snapshot(spark, target)
        return {
            "createdTable": False,
            "jobId": job_id,
            "operation": "reuse",
            "runId": run_id,
            "target": target,
            "snapshotId": snapshot["snapshotId"],
            "committedAt": snapshot["committedAt"],
            "warehouseLocation": snapshot["warehouseLocation"],
            "schemaFingerprint": schema_fingerprint,
            "ruleFingerprint": rule_fingerprint,
            "sourceBoundary": source_boundary or {},
            "_previousSnapshot": None,
        }
    committed = False
    try:
        writer = frame.writeTo(table_identifier)
        if not existed_before:
            writer = (
                writer
                .using("iceberg")
                .tableProperty("format-version", "2")
                .tableProperty("write.format.default", "parquet")
            )
            if partition_columns:
                writer = writer.partitionedBy(*[F.col(quote_identifier(column)) for column in partition_columns])
        if effective_write_mode == "append" and existed_before:
            writer.append()
        elif effective_write_mode == "append":
            writer.create()
        elif existed_before:
            writer.overwrite(F.lit(True))
        else:
            writer.create()
        committed = True
        if truthy(os.environ.get("ASKLAKE_SPARK_FAIL_AFTER_ICEBERG_COMMIT")):
            raise RuntimeError("ICEBERG_FAIL_AFTER_COMMIT_INJECTED")
        snapshot = latest_iceberg_snapshot(spark, target)
        if previous_snapshot and snapshot["snapshotId"] == previous_snapshot["snapshotId"]:
            raise RuntimeError("ICEBERG_SNAPSHOT_DID_NOT_ADVANCE")
        return {
            "createdTable": not existed_before,
            "jobId": job_id,
            "operation": effective_write_mode,
            "runId": run_id,
            "target": target,
            "snapshotId": snapshot["snapshotId"],
            "committedAt": snapshot["committedAt"],
            "warehouseLocation": snapshot["warehouseLocation"],
            "schemaFingerprint": schema_fingerprint,
            "ruleFingerprint": rule_fingerprint,
            "sourceBoundary": source_boundary or {},
            "_previousSnapshot": previous_snapshot,
        }
    except Exception as exc:
        if committed:
            try:
                rollback_iceberg_commit(spark, target, previous_snapshot)
            except Exception as rollback_exc:
                raise IcebergCommitError(
                    f"{exc}; rollback failed: {rollback_exc}"
                ) from exc
        raise IcebergCommitError(str(exc)) from exc


def rollback_iceberg_commit(spark, target, previous_snapshot):
    table_identifier = spark_iceberg_table_identifier(target)
    if previous_snapshot:
        catalog_name = spark_iceberg_catalog_name()
        catalog = quote_spark_identifier(catalog_name)
        namespace_table = (
            f"{catalog_name}.{target['namespace']}.{target['table']}"
            .replace("'", "''")
        )
        snapshot_id = int(previous_snapshot["snapshotId"])
        spark.sql(
            f"CALL {catalog}.system.rollback_to_snapshot("
            f"table => '{namespace_table}', snapshot_id => {snapshot_id})"
        )
        restored_snapshot_id = current_iceberg_snapshot_id(spark, target)
        if restored_snapshot_id != previous_snapshot["snapshotId"]:
            raise RuntimeError("ICEBERG_ROLLBACK_VERIFICATION_FAILED")
        return
    spark.sql(f"DROP TABLE IF EXISTS {table_identifier}")


def kafka_snapshot_boundary_id(source_boundary):
    if not isinstance(source_boundary, dict):
        return ""
    if str(source_boundary.get("kind") or "").strip() != "kafka_snapshot":
        return ""
    return str(source_boundary.get("snapshotId") or "").strip()


def iceberg_source_boundary_marker(source_boundary):
    snapshot_id = kafka_snapshot_boundary_id(source_boundary)
    if snapshot_id:
        return "_asklake_kafka_snapshot_id", snapshot_id
    if not isinstance(source_boundary, dict):
        return "", ""
    if str(source_boundary.get("kind") or "").strip() not in {
        "kafka_continuous_batch",
        "kafka_continuous_replay",
    }:
        return "", ""
    return "_asklake_run_id", str(source_boundary.get("runId") or "").strip()


def iceberg_source_boundary_exists(spark, target, source_boundary):
    marker_column, marker_value = iceberg_source_boundary_marker(source_boundary)
    if not marker_column or not marker_value:
        return False
    table = spark.table(spark_iceberg_table_identifier(target))
    if marker_column not in table.columns:
        return False
    return table.where(
        F.col(marker_column) == F.lit(marker_value)
    ).limit(1).count() > 0


def merge_rule_output_schema(schema_columns, rule_output_schema):
    merged = [dict(column) for column in (schema_columns or []) if isinstance(column, dict)]
    index_by_name = {}
    for index, column in enumerate(merged):
        name = normalize_column_name(column.get("targetName") or column.get("sourceName") or "")
        if name:
            index_by_name[name] = index
    for item in rule_output_schema or []:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        name = str(item[0] or "").strip()
        logical_type = str(item[1] or "String")
        normalized = normalize_column_name(name)
        if not normalized:
            continue
        if normalized in index_by_name:
            merged[index_by_name[normalized]]["type"] = logical_type
            continue
        index_by_name[normalized] = len(merged)
        merged.append({
            "included": True,
            "nullable": True,
            "sourceName": name,
            "targetName": name,
            "type": logical_type,
        })
    return merged


def snapshot_quality_report(quality):
    report = dict(quality or {})
    invalid_rows = int(report.get("invalidRowCount") or 0)
    pass_rate = float(report.get("passRate") if report.get("passRate") is not None else 100.0)
    report.setdefault("failedRules", [])
    report["invalidRows"] = invalid_rows
    report["sampleRows"] = int(report.get("evaluatedRowCount") or 0)
    report["score"] = pass_rate
    report["status"] = "fail" if report.get("blockingFailures", 0) else report.get("status", "pass")
    return report


def cleanup_failed_output_paths(spark, output_path):
    errors = []
    paths = [str(output_path).rstrip("/"), f"{str(output_path).rstrip('/')}_quarantine"]
    for path in paths:
        try:
            hadoop_path = spark._jvm.org.apache.hadoop.fs.Path(path)
            file_system = hadoop_path.getFileSystem(spark._jsc.hadoopConfiguration())
            file_system.delete(hadoop_path, True)
        except Exception as exc:
            reason = " ".join(str(exc).split()) or exc.__class__.__name__
            errors.append({"path": path, "reason": reason[:500]})
    return errors


def make_spark(source_collection=None, iceberg_target=None, *, disable_speculation=False):
    change_detection_source = source_change_detection_mode(source_collection)
    builder = configure_spark_builder(
        SparkSession.builder.appName(os.environ.get("ASKLAKE_SPARK_APP_NAME", "asklake-pipeline-run"))
        .config("spark.sql.caseSensitive", "true")
        .config("spark.hadoop.fs.s3a.change.detection.source", change_detection_source)
        .config("spark.hadoop.fs.s3a.change.detection.mode", "server")
        .config("spark.hadoop.fs.s3a.change.detection.version.required", "true")
    )
    if disable_speculation:
        # RAG stages perform idempotent-but-external HTTP work per partition.
        # A speculative duplicate would waste provider calls and can race the
        # stage callback even though the final writes are job scoped.
        builder = builder.config("spark.speculation", "false")
    if iceberg_target:
        catalog = spark_iceberg_catalog_name()
        jdbc_url = required_env("ASKLAKE_SPARK_ICEBERG_JDBC_URL")
        jdbc_user = required_env("ASKLAKE_SPARK_ICEBERG_JDBC_USER")
        jdbc_password = required_env("ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD")
        warehouse = required_env("ASKLAKE_SPARK_ICEBERG_WAREHOUSE")
        prefix = f"spark.sql.catalog.{catalog}"
        builder = (
            builder
            .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
            .config(prefix, "org.apache.iceberg.spark.SparkCatalog")
            .config(f"{prefix}.type", "jdbc")
            .config(f"{prefix}.uri", jdbc_url)
            .config(f"{prefix}.warehouse", warehouse)
            .config(f"{prefix}.jdbc.user", jdbc_user)
            .config(f"{prefix}.jdbc.password", jdbc_password)
            .config(f"{prefix}.jdbc.init-catalog-tables", "false")
            .config(f"{prefix}.jdbc.schema-version", "V1")
            .config(f"{prefix}.cache-enabled", "false")
            .config(f"{prefix}.table-default.format-version", "2")
            .config(f"{prefix}.table-default.write.format.default", "parquet")
        )
    if change_detection_source == "versionid":
        builder = builder.config("spark.hadoop.fs.s3a.versioned.store", "true")
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("INFO")
    return spark


def s3a_source_object_identity(spark, source_path):
    path = spark._jvm.org.apache.hadoop.fs.Path(source_path)
    status = path.getFileSystem(spark._jsc.hadoopConfiguration()).getFileStatus(path)
    try:
        e_tag = status.getEtag()
    except Exception:
        e_tag = status.getETag()
    try:
        version_id = status.getVersionId()
    except Exception:
        version_id = None
    last_modified = datetime.fromtimestamp(
        int(status.getModificationTime()) / 1000,
        tz=timezone.utc,
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "eTag": str(e_tag or ""),
        "versionId": str(version_id or "") or None,
        "lastModified": last_modified,
        "size": int(status.getLen()),
    }


def verify_spark_source_inventory(spark, source_path, source_collection, *, phase):
    try:
        return verify_incremental_source_inventory(
            source_path,
            source_collection,
            lambda path: s3a_source_object_identity(spark, path),
        )
    except ValueError as exc:
        raise ValueError(f"{exc} phase={phase}") from exc


def source_file_bytes(spark, paths):
    total = 0
    configuration = spark.sparkContext._jsc.hadoopConfiguration()
    for value in paths:
        try:
            path = spark._jvm.org.apache.hadoop.fs.Path(value)
            total += int(path.getFileSystem(configuration).getFileStatus(path).getLen())
        except Exception:
            continue
    return total


def read_source(
    spark,
    source_format,
    source_path,
    schema_columns,
    record_parsing=None,
    source_collection=None,
    transform_steps=None,
):
    source_collection = source_collection or {}
    if source_format == "iceberg":
        return spark.table(spark_iceberg_source_identifier(source_path))
    exact_paths = incremental_source_paths(source_path, source_collection)
    if exact_paths == []:
        return empty_source_frame(spark, schema_columns)
    read_path = exact_paths if exact_paths is not None else source_path
    base_reader = spark.read if exact_paths is not None else apply_source_collection(spark.read, source_collection)
    if source_format == "csv":
        infer_schema = "false" if schema_columns else "true"
        return (
            base_reader.option("header", "true")
            .option("inferSchema", infer_schema)
            .option("quote", '"')
            .option("escape", '"')
            .csv(read_path)
        )
    if source_format == "jsonl":
        reader = base_reader.option("multiLine", "false")
        source_schema = json_source_schema(schema_columns, transform_steps)
        return (reader.schema(source_schema) if source_schema is not None else reader).json(read_path)
    if source_format == "json":
        reader = base_reader.option("multiLine", "true")
        source_schema = json_source_schema(schema_columns, transform_steps)
        return (reader.schema(source_schema) if source_schema is not None else reader).json(read_path)
    if source_format == "parquet":
        return base_reader.parquet(*read_path) if isinstance(read_path, list) else base_reader.parquet(read_path)
    if source_format in {"txt", "text"}:
        if isinstance(record_parsing, dict) and record_parsing.get("enabled"):
            return read_whitespace_records(spark, read_path, record_parsing)
        return base_reader.text(read_path)
    raise ValueError(f"Unsupported Spark source format: {source_format}")


def json_source_schema(schema_columns, transform_steps=None):
    paths = source_contract_paths(schema_columns, transform_steps)
    if not paths:
        return None

    tree = {}
    for path in paths:
        parts = [part for part in str(path).split(".") if part]
        if not parts:
            continue
        current = tree
        for index, part in enumerate(parts):
            is_leaf = index == len(parts) - 1
            existing = current.get(part)
            if is_leaf:
                if isinstance(existing, dict):
                    return None
                current[part] = None
                continue
            if existing is None and part in current:
                return None
            if not isinstance(existing, dict):
                existing = {}
                current[part] = existing
            current = existing
    return json_struct_type(tree) if tree else None


def json_struct_type(tree):
    return T.StructType([
        T.StructField(
            name,
            json_struct_type(value) if isinstance(value, dict) else T.StringType(),
            True,
        )
        for name, value in tree.items()
    ])


def source_contract_paths(schema_columns, transform_steps=None):
    paths = []
    for column in schema_columns or []:
        if not isinstance(column, dict):
            continue
        name = str(column.get("sourceName") or column.get("targetName") or "").strip()
        if name and name not in paths:
            paths.append(name)
    for name in transform_source_paths(transform_steps or []):
        if name and name not in paths:
            paths.append(name)
    return paths


def transform_source_paths(steps):
    paths = []
    for step in steps or []:
        if not step or step.get("enabled") is False:
            continue
        raw = str(step.get("input") or "").strip()
        if (
            not raw
            or contains_row_analyze_call(raw)
            or "," in raw
            or "=" in raw
            or raw.startswith("{")
        ):
            continue
        if raw not in paths:
            paths.append(raw)
    return paths


def read_whitespace_records(spark, source_path, record_parsing):
    if str(record_parsing.get("delimiterKind") or "whitespace") != "whitespace":
        raise ValueError("RECORD_PARSING_UNSUPPORTED_DELIMITER only whitespace is supported")
    expected_field_count = int(record_parsing.get("expectedFieldCount") or 0)
    columns = sorted(record_parsing.get("columns") or [], key=lambda column: int(column.get("position") or 0))
    if expected_field_count <= 0 or len(columns) != expected_field_count:
        raise ValueError(f"RECORD_PARSING_INVALID_CONTRACT expectedFieldCount={expected_field_count} columns={len(columns)}")
    column_names = [normalize_column_name(column.get("name") or f"field_{index + 1}") for index, column in enumerate(columns)]
    if any(not name for name in column_names) or len(set(column_names)) != len(column_names):
        raise ValueError("RECORD_PARSING_INVALID_COLUMNS column names must be non-empty and unique")
    source_paths = source_path if isinstance(source_path, list) else [source_path]
    indexed_rdds = []
    line_offset = 0
    for path in source_paths:
        lines = spark.sparkContext.textFile(path)
        indexed_rdds.append(
            lines.zipWithIndex().map(
                lambda item, offset=line_offset: (int(item[1]) + offset + 1, str(item[0]))
            )
        )
        line_offset += lines.count()
    indexed_lines = spark.sparkContext.union(indexed_rdds)
    raw = spark.createDataFrame(indexed_lines, schema="line_number long, raw_record string")
    non_empty = raw.where(F.length(F.trim(F.col("raw_record"))) > 0)
    if bool(record_parsing.get("header")):
        header_row = non_empty.orderBy("line_number").limit(1).collect()
        if not header_row:
            raise ValueError("RECORD_PARSING_EMPTY_INPUT no non-empty records were found")
        non_empty = non_empty.where(F.col("line_number") != F.lit(int(header_row[0]["line_number"])))
    parsed = non_empty.withColumn("record_fields", F.split(F.trim(F.col("raw_record")), r"\s+"))
    invalid = parsed.where(F.size(F.col("record_fields")) != expected_field_count)
    invalid_count = invalid.count()
    if invalid_count:
        raise ValueError(f"RECORD_FIELD_COUNT_MISMATCH expectedFieldCount={expected_field_count} invalidRows={invalid_count}")
    return parsed.select(*[F.col("record_fields").getItem(index).alias(column_name) for index, column_name in enumerate(column_names)])


def incremental_source_paths(source_path, source_collection):
    if str(source_collection.get("scope") or "file").lower() != "folder":
        return None
    if str(source_collection.get("mode") or "full").lower() != "incremental":
        return None
    object_keys = source_collection.get("objectKeys")
    if not isinstance(object_keys, list):
        return None
    match = re.match(r"^(s3a?)://([^/]+)(?:/.*)?$", str(source_path or ""), flags=re.IGNORECASE)
    if not match:
        raise ValueError("Incremental folder object inventory requires an s3:// or s3a:// source path.")
    scheme, bucket = match.group(1).lower(), match.group(2)
    return [
        f"{scheme}://{bucket}/{str(key).lstrip('/')}"
        for key in object_keys
        if str(key).strip()
    ]


def empty_source_frame(spark, schema_columns):
    names = []
    for index, column in enumerate(schema_columns or []):
        if not isinstance(column, dict):
            continue
        name = normalize_column_name(column.get("sourceName") or column.get("targetName") or f"column_{index + 1}")
        if name and name not in names:
            names.append(name)
    schema = T.StructType([T.StructField(name, T.StringType(), True) for name in names])
    return spark.createDataFrame([], schema)


def apply_source_collection(reader, source_collection):
    if str(source_collection.get("scope") or "file").lower() != "folder":
        return reader
    file_pattern = str(source_collection.get("filePattern") or "").strip()
    if file_pattern:
        reader = reader.option("pathGlobFilter", file_pattern)
    if bool(source_collection.get("recursive")):
        reader = reader.option("recursiveFileLookup", "true")
    incremental_since = str(source_collection.get("incrementalSince") or "").strip()
    incremental_before = str(source_collection.get("incrementalBefore") or "").strip()
    if str(source_collection.get("mode") or "full").lower() == "incremental":
        if incremental_since:
            reader = reader.option("modifiedAfter", spark_modified_timestamp(incremental_since, inclusive_lower=True))
        if incremental_before:
            reader = reader.option("modifiedBefore", spark_modified_timestamp(incremental_before))
    return reader


def spark_modified_timestamp(value, *, inclusive_lower=False):
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid incremental source watermark: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if inclusive_lower:
        parsed -= timedelta(microseconds=1)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")


def parse_partition_columns(value):
    text = str(value or "").strip()
    if not text or text.lower() in {"-", "none", "null", "없음"}:
        return []
    return list(dict.fromkeys(part.strip() for part in text.split("/") if part.strip()))


def resolve_partition_columns(frame, partition_columns):
    resolved = []
    missing = []
    for column_name in partition_columns:
        actual_name = resolve_column_name(frame, column_name)
        if not actual_name:
            missing.append(column_name)
        elif actual_name not in resolved:
            resolved.append(actual_name)
    if missing:
        raise ValueError(f"Partition columns missing from Spark output: {', '.join(missing)}")
    return resolved


def apply_schema_contract(frame, schema_columns, transform_steps=None):
    contracted, required_targets = project_schema_contract(frame, schema_columns, transform_steps)
    null_required = required_null_targets(contracted, required_targets)
    if null_required:
        raise ValueError(f"Approved schema required columns produced null values after casting: {', '.join(null_required)}")
    return contracted


def apply_schema_contract_with_count(frame, schema_columns, transform_steps=None):
    contracted, required_targets = project_schema_contract(frame, schema_columns, transform_steps)
    input_rows, null_required = schema_contract_summary(contracted, required_targets)
    if null_required:
        raise ValueError(f"Approved schema required columns produced null values after casting: {', '.join(null_required)}")
    return contracted, input_rows


def project_schema_contract(frame, schema_columns, transform_steps=None):
    if not schema_columns:
        return frame, []

    included_columns = [column for column in schema_columns if schema_column_included(column)]
    if not included_columns:
        raise ValueError("Approved schema has no included output columns.")

    derived_targets = transform_output_column_names(transform_steps or [])
    expressions = []
    missing_required = []
    required_targets = []
    used_names = set()
    for index, column in enumerate(included_columns):
        source_name = str(column.get("sourceName") or column.get("targetName") or "").strip()
        target_name = unique_column_name(normalize_column_name(column.get("targetName") or source_name) or f"column_{index + 1}", used_names)
        logical_type = str(column.get("type") or "String")
        nullable = bool(column.get("nullable", True))
        is_derived_target = normalize_column_name(target_name) in derived_targets
        resolved = resolve_column_name(frame, source_name) or resolve_column_name(frame, target_name)
        if not resolved:
            if nullable or is_derived_target:
                expressions.append(F.lit(None).cast(spark_sql_type(logical_type)).alias(target_name))
            else:
                missing_required.append(source_name or target_name)
            continue
        if not nullable and not is_derived_target:
            required_targets.append(target_name)
        expressions.append(cast_for_schema(frame, resolved, logical_type).alias(target_name))

    for source_name in transform_input_column_names(transform_steps or []):
        resolved = resolve_column_name(frame, source_name)
        target_name = normalize_column_name(source_name)
        if not resolved or not target_name or target_name in used_names:
            continue
        used_names.add(target_name)
        expressions.append(F.col(quote_identifier(resolved)).alias(target_name))

    if missing_required:
        raise ValueError(f"Approved schema required columns missing from Spark input: {', '.join(missing_required)}")
    if not expressions:
        raise ValueError("Approved schema has no output expressions.")
    return frame.select(*expressions), required_targets


def required_null_targets(frame, required_targets):
    if not required_targets:
        return []

    return schema_contract_summary(frame, required_targets)[1]


def schema_contract_summary(frame, required_targets):
    row_count_alias = "__asklake_schema_input_rows"

    aliases = [f"__asklake_required_null_{index}" for index in range(len(required_targets))]
    summary = frame.agg(
        F.count(F.lit(1)).alias(row_count_alias),
        *[
            F.max(
                F.when(F.col(quote_identifier(target)).isNull(), F.lit(1)).otherwise(F.lit(0))
            ).alias(alias)
            for target, alias in zip(required_targets, aliases)
        ],
    ).first()
    input_rows = int((summary[row_count_alias] if summary is not None else 0) or 0)
    null_required = [
        target
        for target, alias in zip(required_targets, aliases)
        if int((summary[alias] if summary is not None else 0) or 0) > 0
    ]
    return input_rows, null_required


def transform_output_column_names(steps):
    output = set()
    for step in steps:
        if not step or step.get("enabled") is False:
            continue
        name = normalize_column_name(step.get("output") or "")
        if name:
            output.add(name)
    return output


def transform_input_column_names(steps):
    names = []
    for step in steps:
        if not step or step.get("enabled") is False:
            continue
        raw_inputs = [
            str(step.get("input") or ""),
            str(step.get("params") or ""),
        ]
        for raw in raw_inputs:
            if not raw:
                continue
            config_source_fields = review_analysis_config_source_fields(raw)
            if config_source_fields:
                names.extend(config_source_fields)
                continue
            names.extend(review_analyze_source_fields(raw))
            if "," in raw and not contains_row_analyze_call(raw):
                names.extend(part.strip() for part in raw.split(",") if part.strip())
            elif raw and not contains_row_analyze_call(raw) and "=" not in raw:
                names.append(raw.strip())
    seen = set()
    output = []
    for name in names:
        normalized = normalize_column_name(name)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(normalized)
    return output


def evaluate_quality_rules(frame, rules, total_rows=None):
    enabled_rules = [rule for rule in rules if rule and rule.get("enabled") is not False and rule.get("targetColumn")]
    failed_details = []
    failed_condition = None
    blocking_failures = 0

    for rule in enabled_rules:
        target_column = str(rule.get("targetColumn") or "")
        condition = quality_failure_condition(frame, target_column, str(rule.get("validationType") or rule.get("kind") or "Not Null"))
        failed_count = frame.filter(condition).count()
        if failed_count:
            failed_details.append({
                "action": str(rule.get("failureAction") or "Warn"),
                "column": target_column,
                "count": failed_count,
                "id": str(rule.get("id") or target_column),
                "severity": str(rule.get("severity") or "Warning"),
                "validationType": str(rule.get("validationType") or "Not Null"),
            })
            if str(rule.get("failureAction") or "").lower() == "fail run":
                blocking_failures += failed_count
            failed_condition = condition if failed_condition is None else failed_condition | condition

    total_rows = int(total_rows) if total_rows is not None else frame.count()
    invalid_rows = frame.filter(failed_condition).count() if failed_condition is not None else 0
    pass_rate = round(((total_rows - invalid_rows) / total_rows) * 100, 1) if total_rows else 100.0
    status = "pass" if invalid_rows == 0 else "fail" if blocking_failures else "warn"
    summary = f"품질 점수 {pass_rate}% · 유효하지 않은 행 {invalid_rows}개 · 검사 {len(enabled_rules)}개"
    return {
        "blockingFailures": blocking_failures,
        "failedRules": failed_details,
        "invalidRows": invalid_rows,
        "passRate": pass_rate,
        "sampleRows": total_rows,
        "score": pass_rate,
        "status": status,
        "summary": summary,
    }


def quality_failure_condition(frame, target_column, validation_type):
    value = safe_col(frame, target_column)
    normalized = validation_type.lower()
    text_value = value.cast("string")
    if "regex" in normalized:
        return ~(text_value.rlike(r"^[^\s@]+@[^\s@]+\.[^\s@]+$"))
    if "range" in normalized:
        numeric_value = try_cast_double(frame, target_column)
        return numeric_value.isNull() | (numeric_value <= F.lit(0))
    if "accepted" in normalized:
        return ~(text_value.isin("KOR", "JPN", "USA", "KR", "US"))
    if "unique" in normalized:
        return F.lit(False)
    return value.isNull() | (F.length(F.trim(text_value)) == 0)


def collect_sample_rows(frame, limit=10):
    columns = list(frame.columns)
    rows = []
    for row in frame.limit(limit).collect():
        values = []
        for column in columns:
            value = row[column]
            values.append("" if value is None else str(value))
        rows.append(values)
    return rows


def normalize_columns(frame, schema_columns=None, transform_steps=None):
    used = set()
    expressions = []
    for index, column_name in enumerate(frame.columns):
        target = normalize_column_name(column_name) or f"column_{index + 1}"
        candidate = target
        suffix = 2
        while candidate in used:
            candidate = f"{target}_{suffix}"
            suffix += 1
        used.add(candidate)
        expressions.append(F.col(f"`{column_name}`").alias(candidate))
    for source_path in source_contract_paths(schema_columns, transform_steps):
        parts = [part for part in str(source_path).split(".") if part]
        if len(parts) < 2 or not nested_schema_path_exists(frame.schema, parts):
            continue
        target = normalize_column_name(source_path)
        if not target or target in used:
            continue
        used.add(target)
        nested_column = frame[parts[0]]
        for part in parts[1:]:
            nested_column = nested_column.getField(part)
        expressions.append(nested_column.alias(target))
    return frame.select(*expressions)


def nested_schema_path_exists(schema, parts):
    current = schema
    for index, part in enumerate(parts):
        if not isinstance(current, T.StructType):
            return False
        field = next((item for item in current.fields if item.name == part), None)
        if field is None:
            return False
        if index == len(parts) - 1:
            return True
        current = field.dataType
    return False


if __name__ == "__main__":
    raise SystemExit(main())
