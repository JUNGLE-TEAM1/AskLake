import json
import math
import os
import re
import sys
import time
import hashlib
import urllib.error
import urllib.request
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


REVIEW_ROW_ANALYSIS_SUPPORTED_METHODS = {
    "copy",
    "one_of_values",
    "instruction",
}
REVIEW_ROW_ANALYSIS_METHOD_ALIASES = {
    "copy_or_extract_field": "copy",
    "custom_instruction": "instruction",
    "copy": "copy",
    "instruction": "instruction",
    "issue_taxonomy": "one_of_values",
    "issue_category": "one_of_values",
    "issue_subcategory": "one_of_values",
    "severity_4level": "one_of_values",
    "text_classification": "one_of_values",
    "sentiment": "one_of_values",
    "sentiment_3way": "one_of_values",
    "issue_present": "one_of_values",
    "issue_present_binary": "one_of_values",
    "action_needed": "one_of_values",
    "action_needed_binary": "one_of_values",
    "boolean_y_n": "one_of_values",
    "summary": "instruction",
    "evidence": "instruction",
    "extractive_summary": "instruction",
    "evidence_span": "instruction",
}
REVIEW_ROW_ANALYSIS_LLM_CACHE = {}
REVIEW_TEXT_MODEL_CACHE = {}


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
    staging_path = None
    output_write_started = False
    input_rows = 0
    quality = None
    transform = None
    canonical_snapshot = False
    iceberg_commit = None
    iceberg_previous_snapshot = None
    try:
        source_path = required_env("ASKLAKE_SPARK_SOURCE_PATH")
        source_format = required_env("ASKLAKE_SPARK_SOURCE_FORMAT").lower()
        output_path = required_env("ASKLAKE_SPARK_OUTPUT_PATH")
        run_id = required_env("ASKLAKE_SPARK_RUN_ID")
        row_limit = int(os.environ.get("ASKLAKE_SPARK_RUN_ROW_LIMIT", "0") or "0")
        manifest = load_spark_job_manifest()
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
                "inputRows": input_rows,
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
        if iceberg_target:
            written_df = output_df.persist()
            output_rows = written_df.count()
        else:
            writer = output_df.write.mode("overwrite")
            if resolved_partition_columns:
                writer = writer.partitionBy(*resolved_partition_columns)
            output_write_started = True
            writer.parquet(staging_path)
            written_df = spark.read.parquet(staging_path)
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
                "inputRows": input_rows,
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
        else:
            publish_spark_paths(spark, staging_path, output_path, quarantine_staging_path)
            written_df = spark.read.parquet(output_path)
            output_rows = written_df.count()
        ended_at = now_iso()
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "format": source_format,
            "inputRows": input_rows,
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
            "inputRows": input_rows,
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
        write_report(report_file, result)
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


def required_iceberg_identifier(value, field):
    identifier = str(value or "").strip()
    if not identifier or len(identifier) > 255 or any(character in identifier for character in ('`', '"', "'", ";", "\x00")):
        raise ValueError(f"ICEBERG_TARGET_INVALID {field}")
    return identifier


def safe_identifier(value):
    return re.sub(r"[^0-9A-Za-z_-]+", "_", str(value or "value")).strip("_") or "value"


def spark_iceberg_catalog_name():
    return required_iceberg_identifier(
        os.environ.get("ASKLAKE_SPARK_ICEBERG_CATALOG_NAME") or "asklake",
        "sparkCatalog",
    )


def quote_spark_identifier(value):
    return f"`{str(value).replace('`', '``')}`"


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


def make_spark(source_collection=None, iceberg_target=None, *, disable_speculation: bool = False):
    change_detection_source = source_change_detection_mode(source_collection)
    builder = configure_spark_builder(
        SparkSession.builder.appName(os.environ.get("ASKLAKE_SPARK_APP_NAME", "asklake-pipeline-run"))
        .config("spark.sql.caseSensitive", "true")
        .config("spark.hadoop.fs.s3a.change.detection.source", change_detection_source)
        .config("spark.hadoop.fs.s3a.change.detection.mode", "server")
        .config("spark.hadoop.fs.s3a.change.detection.version.required", "true")
    )
    if disable_speculation:
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
    exact_paths = incremental_source_paths(source_path, source_collection)
    if exact_paths == []:
        return empty_source_frame(spark, schema_columns)
    read_path = exact_paths if exact_paths is not None else source_path
    base_reader = spark.read if exact_paths is not None else apply_source_collection(spark.read, source_collection)
    if source_format == "csv":
        infer_schema = "false" if schema_columns else "true"
        reader = (
            base_reader.option("header", "true")
            .option("inferSchema", infer_schema)
            .option("quote", '"')
            .option("escape", '"')
        )
        if schema_columns:
            reader = reader.schema(catalog_struct_type(schema_columns))
        return reader.csv(read_path)
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
    if source_format == "iceberg":
        table_path = source_path[len("iceberg:"):] if source_path.startswith("iceberg:") else source_path
        return spark.table(table_path)
    if source_format in {"txt", "text"}:
        if isinstance(record_parsing, dict) and record_parsing.get("enabled"):
            return read_whitespace_records(spark, read_path, record_parsing)
        return base_reader.text(read_path)
    raise ValueError(f"Unsupported Spark source format: {source_format}")


def json_source_schema(schema_columns, transform_steps=None):
    paths = source_contract_paths(schema_columns, transform_steps)
    if not paths:
        return None

    type_by_path = {
        str(column.get("sourceName") or column.get("targetName") or "").strip(): str(column.get("dataType") or column.get("data_type") or "string")
        for column in schema_columns or []
        if isinstance(column, dict)
    }
    tree = {}
    for path in paths:
        parts = [part for part in str(path).split(".") if part]
        if not parts:
            continue
        current = tree
        data_type = type_by_path.get(str(path), "string")
        for index, part in enumerate(parts):
            is_leaf = index == len(parts) - 1
            existing = current.get(part)
            if is_leaf:
                if isinstance(existing, dict):
                    return None
                current[part] = data_type
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
            json_struct_type(value) if isinstance(value, dict) else catalog_spark_type(value),
            True,
        )
        for name, value in tree.items()
    ])


def catalog_spark_type(data_type):
    text = str(data_type or "string").casefold()
    if any(token in text for token in ("boolean", "bool")):
        return T.BooleanType()
    if any(token in text for token in ("bigint", "long", "int64")):
        return T.LongType()
    if any(token in text for token in ("smallint", "integer", "int32", "int")):
        return T.IntegerType()
    if any(token in text for token in ("double", "float64", "float")):
        return T.DoubleType()
    if any(token in text for token in ("decimal", "numeric")):
        return T.DecimalType(38, 10)
    if "timestamp" in text or "datetime" in text:
        return T.TimestampType()
    if text == "date" or text.endswith(" date"):
        return T.DateType()
    return T.StringType()


def catalog_struct_type(schema_columns):
    fields = []
    seen = set()
    for column in schema_columns or []:
        if not isinstance(column, dict):
            continue
        name = str(column.get("sourceName") or column.get("targetName") or "").strip()
        # CSV columns are flat even when a Catalog name contains a dot.  The
        # backtick quoting in normalize_columns preserves that literal name;
        # dotted JSON paths are handled separately by json_source_schema().
        if not name or name in seen:
            continue
        seen.add(name)
        fields.append(T.StructField(name, catalog_spark_type(column.get("dataType") or column.get("data_type")), True))
    return T.StructType(fields)


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
    if not required_targets:
        return int(frame.count() or 0), []
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


def review_analysis_config_source_fields(text):
    try:
        parsed = json.loads(text or "{}")
    except Exception:
        return []
    if not isinstance(parsed, dict):
        return []
    names = []
    for key in (
        "sourceField",
        "textField",
        "inputField",
        "sourceColumn",
        "ratingField",
        "titleField",
        "asinField",
        "parentAsinField",
        "userField",
        "verifiedPurchaseField",
        "helpfulVoteField",
        "timestampField",
    ):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            names.append(value.strip())
    columns = parsed.get("columns")
    if isinstance(columns, list):
        for column in columns:
            if not isinstance(column, dict):
                continue
            value = column.get("sourceField") or column.get("textField") or column.get("sourceColumn")
            if isinstance(value, str) and value.strip():
                names.append(value.strip())
    return names


def review_analyze_source_fields(text):
    source = str(text or "")
    lowered = source.lower()
    call_name = None
    for candidate in ("review_analyze(", "text_analyze("):
        if candidate in lowered:
            call_name = candidate
            break
    if not call_name or ")" not in source:
        return []
    start = lowered.index(call_name) + len(call_name)
    end = source.find(")", start)
    inner = source[start:end]
    return [part.strip() for part in inner.split(",") if part.strip()]


def contains_row_analyze_call(text):
    lowered = str(text or "").lower()
    return "review_analyze(" in lowered or "text_analyze(" in lowered


def select_final_schema_columns(frame, schema_columns):
    if not schema_columns:
        return frame
    expressions = []
    used_names = set()
    for index, column in enumerate(schema_columns):
        if not schema_column_included(column):
            continue
        target_name = unique_column_name(
            normalize_column_name(column.get("targetName") or column.get("sourceName") or f"column_{index + 1}"),
            used_names,
        )
        resolved = resolve_column_name(frame, target_name) or resolve_column_name(frame, column.get("sourceName") or "")
        if not resolved:
            expressions.append(F.lit(None).cast(spark_sql_type(column.get("type") or "String")).alias(target_name))
            continue
        expressions.append(cast_for_schema(frame, resolved, column.get("type") or "String").alias(target_name))
    return frame.select(*expressions) if expressions else frame


def schema_column_included(column):
    value = column.get("included", True)
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "no", "off"}
    return value is not False


def unique_column_name(name, used_names):
    candidate = name
    suffix = 2
    while candidate in used_names:
        candidate = f"{name}_{suffix}"
        suffix += 1
    used_names.add(candidate)
    return candidate


def cast_for_schema(frame, column_name, logical_type):
    normalized = str(logical_type or "").lower()
    source = F.col(quote_identifier(column_name))
    if "bool" in normalized:
        return try_cast_type(column_name, "boolean")
    if any(token in normalized for token in ["int", "long", "bigint"]):
        return try_cast_type(column_name, "bigint")
    if any(token in normalized for token in ["float", "double", "decimal", "number", "numeric"]):
        return try_cast_type(column_name, "double")
    if "timestamp" in normalized or "datetime" in normalized:
        return F.to_timestamp(source.cast("string"))
    if normalized == "date" or "date" in normalized:
        return F.to_date(source.cast("string"))
    return source.cast(spark_sql_type(logical_type))


def try_cast_type(column_name, target_type):
    return F.expr(f"try_cast({quote_identifier(column_name)} as {target_type})")


def spark_sql_type(logical_type):
    normalized = str(logical_type or "").lower()
    if "bool" in normalized:
        return "boolean"
    if any(token in normalized for token in ["int", "long", "bigint"]):
        return "bigint"
    if any(token in normalized for token in ["float", "double", "decimal", "number", "numeric"]):
        return "double"
    if "timestamp" in normalized or "datetime" in normalized:
        return "timestamp"
    if normalized == "date" or "date" in normalized:
        return "date"
    return "string"


def apply_transform_steps(spark, frame, steps):
    current = frame
    index = 0
    while index < len(steps):
        step = steps[index]
        if not step or step.get("enabled") is False:
            index += 1
            continue
        input_column = str(step.get("input") or "").strip()
        output_column = normalize_column_name(step.get("output") or input_column)
        operation = str(step.get("operation") or step.get("kind") or "").lower()
        params = str(step.get("params") or "")
        if not input_column or not output_column:
            index += 1
            continue
        source = safe_col(current, input_column)
        if "default" in operation:
            expression = F.when(
                source.isNull() | (F.length(F.trim(source.cast("string"))) == 0),
                F.lit(params),
            ).otherwise(source)
        elif "null guard" in operation or "not null" in operation:
            current = current.filter(source.isNotNull() & (F.length(F.trim(source.cast("string"))) > 0))
            if output_column != normalize_column_name(input_column):
                current = current.withColumn(output_column, source)
            index += 1
            continue
        elif "sql expression" in operation and params.strip().lower().startswith("select"):
            current.createOrReplaceTempView("input")
            current = spark.sql(params)
            index += 1
            continue
        elif "sql expression" in operation and params.strip():
            expression = F.expr(params)
        elif is_row_analysis_operation(operation):
            if review_row_analysis_uses_local_llm():
                group = contiguous_review_row_analysis_group(steps, index)
                current = apply_review_row_analysis_group(current, group)
                index += len(group)
                continue
            expression = review_row_analysis_expression(current, output_column, params)
        elif "custom csv classifier" in operation or "csv classifier" in operation:
            expression = custom_csv_classifier_expression(source, params)
        elif "json" in operation:
            expression = F.get_json_object(source.cast("string"), params or "$.value")
        elif "lower" in operation or "trim" in operation:
            expression = F.lower(F.trim(source.cast("string")))
        elif "decimal" in operation or "cast" in operation:
            expression = try_cast_double(current, input_column)
        elif "timestamp" in operation or "date" in operation:
            expression = F.to_timestamp(source.cast("string"))
        elif "mask" in operation:
            expression = F.regexp_replace(source.cast("string"), r"(\d{3})-\d{4}-(\d{4})", "$1-****-$2")
        else:
            expression = source
        current = current.withColumn(output_column, expression)
        index += 1
    return current


def contiguous_review_row_analysis_group(steps, start_index):
    first = steps[start_index]
    first_input = str(first.get("input") or "")
    first_params = str(first.get("params") or "")
    group = []
    for step in steps[start_index:]:
        if not step or step.get("enabled") is False or not is_review_row_analysis_step(step):
            break
        if str(step.get("input") or "") != first_input or str(step.get("params") or "") != first_params:
            break
        group.append(step)
    return group or [first]


def apply_review_row_analysis_group(frame, group):
    first = group[0]
    config = parse_review_row_analysis_config(str(first.get("params") or ""))
    columns = review_row_analysis_group_columns(group, config)
    payload_column = unique_temp_column(frame, "__asklake_review_analysis_payload")
    current = frame.withColumn(payload_column, local_llm_review_row_analysis_payload_expression(frame, config, columns))
    for step in group:
        output_column = normalize_column_name(step.get("output") or "")
        if not output_column:
            continue
        current = current.withColumn(
            output_column,
            F.get_json_object(F.col(quote_identifier(payload_column)), f"$.{output_column}"),
        )
    return current.drop(payload_column)


def review_row_analysis_group_columns(group, config):
    raw_columns = config.get("columns")
    columns = []
    seen = set()
    if isinstance(raw_columns, list):
        for raw_column in raw_columns:
            if not isinstance(raw_column, dict):
                continue
            target = normalize_column_name(raw_column.get("targetName") or raw_column.get("name") or "")
            if not target or target in seen:
                continue
            method = normalize_review_row_analysis_method(raw_column.get("method") or raw_column.get("analysisMethod")) or "copy"
            seen.add(target)
            columns.append({
                "allowedValues": review_row_analysis_expected_values(method, review_row_analysis_allowed_values(raw_column, config)),
                "instruction": str(raw_column.get("instruction") or raw_column.get("description") or ""),
                "method": method,
                "targetName": target,
                "type": str(raw_column.get("type") or "String"),
            })
    for step in group:
        target = normalize_column_name(step.get("output") or "")
        if not target or target in seen:
            continue
        seen.add(target)
        columns.append({
            "allowedValues": [],
            "instruction": "",
            "method": "copy",
            "targetName": target,
            "type": "String",
        })
    return columns


def unique_temp_column(frame, prefix):
    candidate = prefix
    suffix = 2
    existing = set(frame.columns)
    while candidate in existing:
        candidate = f"{prefix}_{suffix}"
        suffix += 1
    return candidate


def review_row_analysis_expression(frame, output_column, params):
    config = parse_review_row_analysis_config(params)
    target = normalize_column_name(config.get("outputColumn") or output_column)
    column_config = review_row_analysis_column_config(config, target)
    method = review_row_analysis_method(column_config, config)
    source_field = column_config.get("sourceField") or config.get("sourceField") or "text"
    if review_row_analysis_uses_local_llm():
        return local_llm_review_row_analysis_expression(frame, target, config, column_config, source_field, method)
    rating = try_cast_double(frame, config.get("ratingField") or "rating")
    asin = safe_col(frame, config.get("asinField") or "asin").cast("string")
    parent_asin = safe_col(frame, config.get("parentAsinField") or "parent_asin").cast("string")
    user_id = safe_col(frame, config.get("userField") or "user_id").cast("string")
    verified_purchase = safe_col(frame, config.get("verifiedPurchaseField") or "verified_purchase").cast("string")
    helpful_vote = safe_col(frame, config.get("helpfulVoteField") or "helpful_vote").cast("string")
    timestamp = safe_col(frame, config.get("timestampField") or "timestamp").cast("string")
    title = safe_col(frame, config.get("titleField") or "title").cast("string")
    text = safe_col(frame, config.get("textField") or source_field).cast("string")
    source_text_present = review_source_text_present(title, text)
    haystack = F.lower(F.concat_ws(" ", title, text))
    negative_signal = haystack.rlike("bad|broken|defective|refund|return|stopped|dead|disappointed|waste|not working")
    safety_signal = haystack.rlike("fire|smoke|explode|burn|hot|overheat|unsafe|danger|battery")
    charging_signal = haystack.rlike("charge|charging|charger|power|cable|usb|plug")
    screen_signal = haystack.rlike("screen|display|glass|crack|touch|protector")
    shipping_signal = haystack.rlike("shipping|delivery|package|arrived|late|box")
    listing_signal = haystack.rlike("fake|wrong|not as described|different|missing")
    boolean_signal = haystack.rlike("click|clicked|tap|tapped|pressed|selected|subscribe|subscribed|buy|bought|purchase|purchased")
    issue_signal = negative_signal | safety_signal | charging_signal | screen_signal | shipping_signal | listing_signal
    action_signal = (
        (rating <= 2)
        | safety_signal
        | haystack.rlike(
            "refund|return|replace|replacement|not working|doesn't work|does not work|didn't work|stopped working|"
            "broken|broke|cracked|shattered|dead|defective|failed|missing|wrong|fake|never arrived|not fit|doesn't fit|"
            "does not fit|won't charge|does not charge|doesn't charge"
        )
    )

    if method == "copy":
        return review_copy_expression(
            frame,
            target,
            source_field,
            {
                "asin": asin,
                "helpful_vote": helpful_vote,
                "parent_asin": parent_asin,
                "rating": rating,
                "text": text,
                "timestamp": timestamp,
                "title": title,
                "user_id": user_id,
                "verified_purchase": verified_purchase,
            },
        )
    if method == "one_of_values":
        allowed_values = review_row_analysis_allowed_values(column_config, config)
        portable_expression = review_portable_text_model_expression(
            frame,
            target,
            allowed_values,
            config,
            column_config,
            source_field,
        )
        if portable_expression is not None:
            return F.when(source_text_present, portable_expression).otherwise(F.lit(None).cast("string"))
        if review_text_model_required(config, column_config):
            raise ValueError(
                f"Portable review text model artifact is required but was not found for column '{target}'."
            )
        fallback_expression = review_one_of_values_expression(
            frame,
            target,
            allowed_values,
            rating,
            haystack,
            {
                "action": action_signal,
                "boolean": boolean_signal,
                "charging": charging_signal,
                "issue": issue_signal,
                "listing": listing_signal,
                "negative": negative_signal,
                "safety": safety_signal,
                "screen": screen_signal,
                "shipping": shipping_signal,
            },
        )
        return F.when(source_text_present, fallback_expression).otherwise(F.lit(None).cast("string"))
    if method == "instruction":
        instruction_expression = review_instruction_expression(target, column_config, title, text)
        return F.when(source_text_present, instruction_expression).otherwise(F.lit(None).cast("string"))
    return F.lit("")


def review_source_text_present(title, text):
    combined = F.trim(F.regexp_replace(F.concat_ws(" ", title, text), r"\s+", " "))
    return combined.isNotNull() & (F.length(combined) > 0)


def review_instruction_expression(target, column_config, title, text):
    instruction = str(column_config.get("instruction") or column_config.get("description") or "").lower()
    normalized_target = normalize_column_name(target)
    combined = F.trim(F.regexp_replace(F.concat_ws(" ", title, text), r"\s+", " "))
    if "summary" in normalized_target or "summar" in instruction or "요약" in instruction:
        return F.substring(combined, 1, 180)
    if (
        "evidence" in normalized_target
        or "reason" in normalized_target
        or "evidence" in instruction
        or "reason" in instruction
        or "근거" in instruction
    ):
        return F.substring(combined, 1, 240)
    return F.substring(combined, 1, 240)


def review_row_analysis_uses_local_llm():
    return os.environ.get("ASKLAKE_REVIEW_ANALYSIS_RUNTIME", "scalable").strip().lower() in {
        "local_llm",
        "llm",
        "row_llm",
    }


def local_llm_review_row_analysis_expression(frame, target, config, column_config, source_field, method):
    columns = normalize_review_analysis_llm_columns(config, target, column_config, method)
    schema_json = json.dumps(columns, ensure_ascii=False, sort_keys=True)
    row_json = F.to_json(F.struct(*[F.col(quote_identifier(column)).alias(column) for column in frame.columns]))

    def analyze_target(raw_row_json):
        return local_llm_review_row_target(raw_row_json, target, schema_json, source_field)

    return F.udf(analyze_target, T.StringType())(row_json)


def local_llm_review_row_analysis_payload_expression(frame, config, columns):
    schema_json = json.dumps(columns, ensure_ascii=False, sort_keys=True)
    row_json = F.to_json(F.struct(*[F.col(quote_identifier(column)).alias(column) for column in frame.columns]))

    def analyze_payload(raw_row_json):
        row = parse_json_object(raw_row_json)
        cache_key = hashlib.sha1(f"{schema_json}\n{raw_row_json}".encode("utf-8", "ignore")).hexdigest()
        if cache_key not in REVIEW_ROW_ANALYSIS_LLM_CACHE:
            REVIEW_ROW_ANALYSIS_LLM_CACHE[cache_key] = call_local_review_llm(
                row,
                parse_json_array(schema_json),
                config.get("sourceField") or "text",
            )
        analyzed = REVIEW_ROW_ANALYSIS_LLM_CACHE.get(cache_key) or {}
        payload = {}
        for column in parse_json_array(schema_json):
            target = column.get("targetName") or ""
            value = analyzed.get(target)
            if value in (None, "") and column.get("method") == "copy":
                value = local_copy_or_extract_value(row, target, config.get("sourceField") or "text")
            allowed_values = column.get("allowedValues") or []
            if allowed_values:
                value = canonical_allowed_value(value, allowed_values)
            payload[target] = "" if value is None else value
        return json.dumps(payload, ensure_ascii=False)

    return F.udf(analyze_payload, T.StringType())(row_json)


def normalize_review_analysis_llm_columns(config, target, column_config, method):
    raw_columns = config.get("columns")
    if not isinstance(raw_columns, list) or not raw_columns:
        raw_columns = [{**column_config, "targetName": target, "method": method}]
    columns = []
    seen = set()
    for raw_column in raw_columns:
        if not isinstance(raw_column, dict):
            continue
        target_name = normalize_column_name(raw_column.get("targetName") or raw_column.get("name") or "")
        if not target_name or target_name in seen:
            continue
        seen.add(target_name)
        column_method = normalize_review_row_analysis_method(
            raw_column.get("method") or raw_column.get("analysisMethod") or method
        ) or "copy"
        columns.append({
            "allowedValues": review_row_analysis_expected_values(
                column_method,
                review_row_analysis_allowed_values(raw_column, config),
            ),
            "instruction": str(raw_column.get("instruction") or raw_column.get("description") or ""),
            "method": column_method,
            "targetName": target_name,
            "type": str(raw_column.get("type") or "String"),
        })
    if target not in {column["targetName"] for column in columns}:
        columns.append({
            "allowedValues": review_row_analysis_expected_values(method, review_row_analysis_allowed_values(column_config, config)),
            "instruction": str(column_config.get("instruction") or column_config.get("description") or ""),
            "method": method or "copy",
            "targetName": target,
            "type": str(column_config.get("type") or "String"),
        })
    return columns


def local_llm_review_row_target(raw_row_json, target, schema_json, source_field):
    row = parse_json_object(raw_row_json)
    columns = parse_json_array(schema_json)
    cache_key = hashlib.sha1(f"{schema_json}\n{raw_row_json}".encode("utf-8", "ignore")).hexdigest()
    if cache_key not in REVIEW_ROW_ANALYSIS_LLM_CACHE:
        REVIEW_ROW_ANALYSIS_LLM_CACHE[cache_key] = call_local_review_llm(row, columns, source_field)
    analyzed = REVIEW_ROW_ANALYSIS_LLM_CACHE.get(cache_key) or {}
    column = next((item for item in columns if item.get("targetName") == target), {})
    value = analyzed.get(target)
    if value in (None, "") and column.get("method") == "copy":
        value = local_copy_or_extract_value(row, target, source_field)
    allowed_values = column.get("allowedValues") or []
    if allowed_values:
        value = canonical_allowed_value(value, allowed_values)
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def call_local_review_llm(row, columns, source_field="text"):
    endpoint = os.environ.get("ASKLAKE_LOCAL_LLM_ENDPOINT") or "http://host.docker.internal:1234/v1/chat/completions"
    model = os.environ.get("ASKLAKE_LOCAL_LLM_MODEL") or "local-review-analyzer"
    timeout_seconds = int(os.environ.get("ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS", "120") or "120")
    max_chars = int(os.environ.get("ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS", "9000") or "9000")
    prompt = "\n".join([
        "Analyze this one source row into one structured CSV output row.",
        "Use the configured text/source field when present, but you may inspect the full row for copied identifiers and context.",
        "Return one minified JSON object only. No markdown, comments, or prose.",
        "Keys must exactly match requestedColumns.targetName.",
        "For columns with allowedValues, choose exactly one value from allowedValues.",
        "For classification/category fields, use concise snake_case labels.",
        "For summary, evidence, and extraction fields, use only facts present in the row.",
        f"sourceField: {source_field}",
        f"sourceText: {truncate_text(local_copy_or_extract_value(row, source_field, source_field), max_chars)}",
        f"requestedColumns: {json.dumps(columns, ensure_ascii=False)}",
        f"sourceRow: {truncate_text(json.dumps(row, ensure_ascii=False), max_chars)}",
    ])
    payload = {
        "messages": [
            {"role": "system", "content": "You are a strict JSON text-row structuring analyzer for Spark ETL."},
            {"role": "user", "content": prompt},
        ],
        "model": model,
        "temperature": 0,
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Local LLM text row analysis failed: {exc}") from exc
    parsed = parse_json_object(body)
    content = (((parsed.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    output = parse_json_object(content)
    if not output:
        raise RuntimeError("Local LLM text row analysis returned no JSON object.")
    return output


def parse_json_object(value):
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        text = str(value or "")
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
    return {}


def parse_json_array(value):
    try:
        parsed = json.loads(value or "[]")
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def canonical_allowed_value(value, allowed_values):
    normalized_value = str(value or "").strip().lower()
    for allowed_value in allowed_values:
        if str(allowed_value).strip().lower() == normalized_value:
            return str(allowed_value)
    return ""


def local_copy_or_extract_value(row, target, source_field):
    normalized_target = normalize_column_name(target)
    normalized_source = normalize_column_name(source_field)
    for key, value in row.items():
        if normalize_column_name(key) in {normalized_target, normalized_source} and value is not None:
            return value
    if normalized_target in {"review_id", "id"}:
        seed = "|".join(str(row.get(key, "")) for key in ["asin", "parent_asin", "user_id", "timestamp", "title", "text"])
        return hashlib.sha1(seed.encode("utf-8", "ignore")).hexdigest()[:16]
    aliases = {
        "body": "text",
        "content": "text",
        "event_time": "timestamp",
        "helpful": "helpful_vote",
        "message": "text",
        "review_text": "text",
        "score": "rating",
        "user": "user_id",
        "value": "text",
    }
    alias = aliases.get(normalized_target)
    if alias:
        for key, value in row.items():
            if normalize_column_name(key) == alias and value is not None:
                return value
    for key, value in row.items():
        if normalize_column_name(key) == normalized_source and value is not None:
            return value
    return ""


def review_row_analysis_method(column_config, config):
    raw_method = (
        column_config.get("method")
        or column_config.get("analysisMethod")
        or config.get("method")
        or config.get("analysisMethod")
        or ""
    )
    return normalize_review_row_analysis_method(raw_method)


def normalize_review_row_analysis_method(value):
    raw = str(value or "").split(":", 1)[0].strip().lower()
    normalized = REVIEW_ROW_ANALYSIS_METHOD_ALIASES.get(raw, raw)
    return normalized if normalized in REVIEW_ROW_ANALYSIS_SUPPORTED_METHODS else ""


def review_row_analysis_allowed_values(column_config, config):
    raw_values = None
    for source in (column_config, config):
        for key in ("allowedValues", "allowed_values", "values"):
            if isinstance(source, dict) and source.get(key) is not None:
                raw_values = source.get(key)
                break
        if raw_values is not None:
            break
    if isinstance(raw_values, list):
        values = raw_values
    else:
        values = str(raw_values or "").replace("\r", "\n").replace(",", "\n").split("\n")
    return [str(value).strip() for value in values if str(value).strip()]


def review_copy_expression(frame, target, source_field, field_expressions):
    normalized_source = normalize_column_name(source_field)
    if target in {"review_id", "id"}:
        return F.sha2(
            F.concat_ws(
                "|",
                field_expressions["asin"].cast("string"),
                field_expressions["parent_asin"].cast("string"),
                field_expressions["user_id"].cast("string"),
                field_expressions["timestamp"].cast("string"),
                field_expressions["title"].cast("string"),
                field_expressions["text"].cast("string"),
            ),
            256,
        )
    aliases = {
        "body": "text",
        "content": "text",
        "event_time": "timestamp",
        "helpful": "helpful_vote",
        "message": "text",
        "review_text": "text",
        "score": "rating",
        "user": "user_id",
        "value": "text",
    }
    field_key = aliases.get(target, target)
    fallback = None
    if field_key in field_expressions:
        fallback = field_expressions[field_key]
    else:
        source_key = aliases.get(normalized_source, normalized_source)
        if source_key in field_expressions:
            fallback = field_expressions[source_key]
        else:
            resolved_source = first_matching_column(frame, normalized_source)
            fallback = safe_col(frame, resolved_source) if resolved_source else field_expressions.get("text", F.lit(""))
    raw_target = first_matching_column(frame, target)
    if raw_target:
        raw_value = safe_col(frame, raw_target).cast("string")
        return F.when(F.length(F.trim(raw_value)) > 0, raw_value).otherwise(fallback)
    if target == normalized_source:
        return safe_col(frame, source_field)
    return fallback


def review_portable_text_model_expression(frame, target, allowed_values, config, column_config, source_field):
    model_path = resolve_review_text_model_path(target, allowed_values, review_row_analysis_model_artifact(column_config, config))
    if not model_path:
        return None
    title_field = config.get("titleField") or "title"
    text_field = column_config.get("sourceField") or config.get("textField") or config.get("sourceField") or source_field or "text"
    rating_field = config.get("ratingField") or "rating"
    title_col = safe_col(frame, title_field).cast("string")
    text_col = safe_col(frame, text_field).cast("string")
    rating_col = try_cast_double(frame, rating_field)
    normalized_allowed = [str(value) for value in allowed_values]

    def predict_with_model(title, text, rating):
        predicted = portable_review_text_predict(model_path, title, text, rating)
        if normalized_allowed:
            return canonical_allowed_value(predicted, normalized_allowed) or normalized_allowed[0]
        return predicted or ""

    return F.udf(predict_with_model, T.StringType())(title_col, text_col, rating_col)


def review_text_model_required(config, column_config):
    if review_row_analysis_fallback_allowed(config, column_config):
        return False
    value = column_config.get("requireModel")
    if value is None:
        value = column_config.get("requirePortableModel")
    if value is None:
        value = config.get("requireModel")
    if value is None:
        value = config.get("requirePortableModel")
    if value is None:
        value = os.environ.get("ASKLAKE_REVIEW_TEXT_MODEL_REQUIRED", "")
    if value is None or str(value).strip() == "":
        return True
    return truthy(value)


def review_row_analysis_fallback_allowed(config, column_config):
    for source in [column_config, config]:
        if not isinstance(source, dict):
            continue
        for key in ["fallbackAllowed", "allowFallback"]:
            if key in source:
                return truthy(source.get(key))
        policy = str(source.get("fallbackPolicy") or "").strip().lower()
        if policy in {"rule", "rules", "fallback_rule", "allow"}:
            return True
    return False


def review_row_analysis_model_selection_policy(column_config, config):
    for source in [column_config, config]:
        if not isinstance(source, dict):
            continue
        value = str(source.get("modelSelectionPolicy") or source.get("modelPolicy") or "").strip().lower()
        if value:
            return value
    if review_row_analysis_model_artifact(column_config, config):
        return "explicit"
    return "auto"


def resolve_review_text_model_path(target, allowed_values, preferred_artifact=""):
    root = os.environ.get("ASKLAKE_REVIEW_TEXT_MODEL_ROOT", "").strip()
    if not root or not os.path.isdir(root):
        return ""
    normalized_target = normalize_column_name(target)
    direct = os.path.join(root, f"{normalized_target}.portable_linear_svc.json")
    candidates = [direct]
    preferred = str(preferred_artifact or "").strip()
    if preferred:
        preferred_path = preferred if os.path.isabs(preferred) else os.path.join(root, os.path.basename(preferred))
        candidates.insert(0, preferred_path)
        if not os.path.exists(preferred_path):
            preferred_name = os.path.basename(preferred)
            for current_root, _dirs, files in os.walk(root):
                if preferred_name in files:
                    candidates.insert(0, os.path.join(current_root, preferred_name))
                    break
    if not os.path.exists(direct):
        for current_root, _dirs, files in os.walk(root):
            filename = f"{normalized_target}.portable_linear_svc.json"
            if filename in files:
                candidates.append(os.path.join(current_root, filename))
                break
    for candidate in candidates:
        if not os.path.exists(candidate):
            continue
        try:
            model = load_review_text_model(candidate)
        except Exception:
            continue
        model_target = normalize_column_name(model.get("targetName") or model.get("targetColumn") or normalized_target)
        if model_target and model_target != normalized_target:
            continue
        classes = [str(value) for value in model.get("classes") or []]
        model_allowed_values = [str(value) for value in model.get("allowedValues") or []]
        if not classes:
            continue
        if allowed_values:
            allowed_normalized = {str(value).strip().lower() for value in allowed_values}
            if model_allowed_values:
                model_allowed_normalized = {value.strip().lower() for value in model_allowed_values}
                if model_allowed_normalized != allowed_normalized:
                    continue
            else:
                class_normalized = {value.strip().lower() for value in classes}
                if not class_normalized.issubset(allowed_normalized):
                    continue
        return candidate
    return ""


def review_row_analysis_model_artifact(column_config, config):
    for source in [column_config, config]:
        if not isinstance(source, dict):
            continue
        for key in ["modelArtifact", "selectedModelArtifact", "modelPath"]:
            value = str(source.get(key) or "").strip()
            if value:
                return value
    return ""


def load_review_text_model(model_path):
    if model_path not in REVIEW_TEXT_MODEL_CACHE:
        with open(model_path, "r", encoding="utf-8") as handle:
            model = json.load(handle)
        vocabulary = model.get("vectorizer", {}).get("vocabulary") or []
        model["_vocabularyIndex"] = {term: index for index, term in enumerate(vocabulary)}
        REVIEW_TEXT_MODEL_CACHE[model_path] = model
    return REVIEW_TEXT_MODEL_CACHE[model_path]


def review_text_model_metrics(model_path):
    if not model_path:
        return {}
    try:
        metrics = load_review_text_model(model_path).get("metrics") or {}
    except Exception:
        return {}
    return metrics if isinstance(metrics, dict) else {}


def portable_review_text_predict(model_path, title, text, rating):
    model = load_review_text_model(model_path)
    feature_values = portable_review_text_features(model, title, text, rating)
    classes = [str(value) for value in model.get("classes") or []]
    coefficients = model.get("coef") or []
    intercepts = model.get("intercept") or []
    if not classes or not coefficients:
        return ""
    if len(classes) == 2 and len(coefficients) == 1:
        score = float(intercepts[0] if intercepts else 0.0) + sparse_dot(coefficients[0], feature_values)
        return classes[1] if score > 0 else classes[0]
    best_class = classes[0]
    best_score = None
    for index, label in enumerate(classes):
        coef = coefficients[index] if index < len(coefficients) else []
        score = float(intercepts[index] if index < len(intercepts) else 0.0) + sparse_dot(coef, feature_values)
        if best_score is None or score > best_score:
            best_class = label
            best_score = score
    return best_class


def portable_review_text_features(model, title, text, rating):
    vectorizer = model.get("vectorizer") or {}
    vocab_index = model.get("_vocabularyIndex") or {}
    idf = vectorizer.get("idf") or []
    ngram_range = vectorizer.get("ngramRange") or [1, 1]
    min_n = int(ngram_range[0] if len(ngram_range) > 0 else 1)
    max_n = int(ngram_range[1] if len(ngram_range) > 1 else min_n)
    combined = clean_review_text(f"{title or ''} {text or ''}").lower()
    tokens = re.findall(r"\b\w\w+\b", combined, flags=re.UNICODE)
    counts = {}
    for ngram_size in range(min_n, max_n + 1):
        if ngram_size <= 0 or len(tokens) < ngram_size:
            continue
        for index in range(0, len(tokens) - ngram_size + 1):
            term = " ".join(tokens[index:index + ngram_size])
            term_index = vocab_index.get(term)
            if term_index is None:
                continue
            counts[term_index] = counts.get(term_index, 0) + 1
    feature_values = {}
    norm_sum = 0.0
    for index, count in counts.items():
        value = 1.0 + math.log(float(count))
        if index < len(idf):
            value *= float(idf[index])
        feature_values[index] = value
        norm_sum += value * value
    if norm_sum > 0:
        norm = math.sqrt(norm_sum)
        for index in list(feature_values):
            feature_values[index] = feature_values[index] / norm

    text_feature_count = len(vocab_index)
    dense_values = portable_dense_features_from_values(model, combined, rating)
    for offset, value in enumerate(dense_values):
        if value:
            feature_values[text_feature_count + offset] = value
    return feature_values


def portable_dense_features_from_values(model, combined_text, rating):
    dense = model.get("dense") or {}
    scale = float(dense.get("scale") or 1.0)
    try:
        numeric_rating = float(rating or 0)
    except Exception:
        numeric_rating = 0.0
    has_rating = numeric_rating > 0
    values = [
        numeric_rating / 5.0 if has_rating else 0.0,
        1.0 if has_rating and numeric_rating <= 1 else 0.0,
        1.0 if has_rating and numeric_rating <= 2 else 0.0,
        1.0 if has_rating and numeric_rating == 3 else 0.0,
        1.0 if has_rating and numeric_rating >= 4 else 0.0,
        1.0 if has_rating and numeric_rating == 5 else 0.0,
    ]
    for pattern_item in dense.get("patterns") or []:
        pattern = ""
        if isinstance(pattern_item, list) and len(pattern_item) >= 2:
            pattern = str(pattern_item[1])
        elif isinstance(pattern_item, dict):
            pattern = str(pattern_item.get("pattern") or "")
        values.append(1.0 if pattern and re.search(pattern, combined_text) else 0.0)
    return [value * scale for value in values]


def sparse_dot(coefficients, feature_values):
    total = 0.0
    for index, value in feature_values.items():
        if index < len(coefficients):
            total += float(coefficients[index]) * float(value)
    return total


def clean_review_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def review_one_of_values_expression(frame, target, allowed_values, rating, haystack, signals):
    if not allowed_values:
        return F.lit("")
    fallback = allowed_values[0]
    expression = None
    for allowed_value in allowed_values:
        condition = review_allowed_value_condition(allowed_value, rating, haystack, signals)
        if condition is None:
            continue
        expression = F.when(condition, F.lit(allowed_value)) if expression is None else expression.when(condition, F.lit(allowed_value))
    classified = expression.otherwise(F.lit(fallback)) if expression is not None else F.lit(fallback)
    raw_target = first_matching_column(frame, target)
    if not raw_target:
        return classified
    raw_value = safe_col(frame, raw_target).cast("string")
    return F.when(raw_value.isin(*allowed_values), raw_value).otherwise(classified)


def review_allowed_value_condition(value, rating, haystack, signals):
    key = normalize_column_name(value)
    if not key:
        return None
    positive_signal = (rating >= 4) & ~signals["negative"]
    if key in {"y", "yes", "true"}:
        return signals["boolean"]
    if key in {"n", "no", "false"}:
        return ~signals["boolean"]
    if "negative" in key or key == "neg":
        return (rating <= 2) | signals["negative"]
    if "mixed" in key or "neutral" in key:
        return rating == 3
    if "positive" in key:
        return positive_signal
    if "critical" in key:
        return signals["safety"]
    if "high" in key:
        return (rating <= 2) | signals["negative"]
    if "medium" in key:
        return rating == 3
    if "low" in key:
        return positive_signal
    if any(token in key for token in ["battery", "safety", "fire", "smoke", "overheat"]):
        return signals["safety"] | signals["charging"]
    if any(token in key for token in ["charge", "charging", "charger", "power", "cable", "usb", "plug"]):
        return signals["charging"]
    if any(token in key for token in ["screen", "display", "glass", "touch"]):
        return signals["screen"]
    if any(token in key for token in ["shipping", "delivery", "package", "arrived", "box"]):
        return signals["shipping"]
    if any(token in key for token in ["listing", "mismatch", "accuracy", "description", "wrong", "missing"]):
        return signals["listing"]
    if any(token in key for token in ["durability", "quality", "defective", "broken", "general_issue"]):
        return signals["negative"]
    tokens = [
        token
        for token in key.split("_")
        if len(token) > 2 and token not in {"and", "for", "from", "not", "one", "the", "with"}
    ]
    condition = None
    for token in tokens:
        token_condition = haystack.contains(token)
        condition = token_condition if condition is None else condition | token_condition
    return condition


def review_row_analysis_column_config(config, target):
    columns = config.get("columns")
    if isinstance(columns, list):
        for column in columns:
            if not isinstance(column, dict):
                continue
            candidate = normalize_column_name(column.get("targetName") or column.get("value") or "")
            if candidate == target:
                return column
    return {}


def first_matching_column(frame, target):
    normalized = {normalize_column_name(column): column for column in frame.columns}
    return normalized.get(target)


def parse_review_row_analysis_config(params):
    if not params:
        return {}
    try:
        parsed = json.loads(params)
        if isinstance(parsed, dict):
            output = parsed.get("outputColumn")
            columns = parsed.get("columns")
            if not output and isinstance(columns, list) and len(columns) == 1 and isinstance(columns[0], dict):
                output = columns[0].get("targetName")
            return {
                **parsed,
                "outputColumn": output or parsed.get("targetName") or "",
            }
    except Exception:
        pass
    text = str(params)
    output = text.split("=", 1)[0].strip() if "=" in text else ""
    fields = {}
    lowered = text.lower()
    call_name = "review_analyze(" if "review_analyze(" in lowered else "text_analyze(" if "text_analyze(" in lowered else ""
    if call_name and ")" in text:
        start = lowered.index(call_name) + len(call_name)
        end = text.find(")", start)
        inner = text[start:end]
        parts = [part.strip() for part in inner.split(",") if part.strip()]
        if call_name == "text_analyze(":
            if parts:
                fields["sourceField"] = parts[0]
                fields["textField"] = parts[0]
        else:
            for key, value in zip(["ratingField", "titleField", "textField", "asinField"], parts):
                fields[key] = value
    return {"outputColumn": output, **fields}


def plan_review_row_analysis_checks(steps):
    review_steps = [
        step
        for step in steps
        if step
        and step.get("enabled") is not False
        and is_review_row_analysis_step(step)
    ]
    checks = []
    for step in review_steps:
        step_output = normalize_column_name(step.get("output") or "")
        config = parse_review_row_analysis_config(str(step.get("params") or ""))
        target = normalize_column_name(config.get("outputColumn") or step_output)
        column_config = review_row_analysis_column_config(config, target)
        raw_method = str(
            column_config.get("method")
            or column_config.get("analysisMethod")
            or config.get("method")
            or config.get("analysisMethod")
            or ""
        )
        method = review_row_analysis_method(column_config, config)
        allowed_values = review_row_analysis_allowed_values(column_config, config)
        selected_model_artifact = review_row_analysis_model_artifact(column_config, config)
        portable_model_path = resolve_review_text_model_path(target, allowed_values, selected_model_artifact) if method == "one_of_values" else ""
        model_required = review_text_model_required(config, column_config) if method == "one_of_values" else False
        fallback_allowed = review_row_analysis_fallback_allowed(config, column_config) if method == "one_of_values" else False
        model_selection_policy = review_row_analysis_model_selection_policy(column_config, config) if method == "one_of_values" else "none"
        check = review_row_analysis_check_payload(
            allowed_values=allowed_values,
            id_value=str(step.get("id") or target or step_output),
            method=method,
            model_required=model_required,
            output=step_output or target,
            portable_model_path=portable_model_path,
            raw_method=raw_method,
            selected_model_artifact=selected_model_artifact,
            target=target,
            total_rows=0,
        )
        check["fallbackAllowed"] = fallback_allowed
        check["modelSelectionPolicy"] = model_selection_policy
        check["resolvedModelArtifact"] = os.path.basename(portable_model_path) if portable_model_path else ""
        if not method:
            check.update({
                "invalidRows": 0,
                "runtimeStatus": "unsupported_method",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
        elif method == "one_of_values" and not allowed_values:
            check.update({
                "invalidRows": 0,
                "runtimeStatus": "missing_allowed_values",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
        elif method == "one_of_values" and model_required and not portable_model_path:
            check.update({
                "invalidRows": 0,
                "runtimeStatus": "missing_model_artifact",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
        elif method == "one_of_values" and portable_model_path:
            check.update({
                "runtimeStatus": "portable_text_model_planned",
                "validationStatus": "model_runtime_planned",
            })
        elif method == "one_of_values":
            check.update({
                "fallbackUsed": True,
                "runtimeStatus": "rule_fallback_planned",
                "validationStatus": "fallback_structural_check_only",
            })
        else:
            check.update({
                "runtimeStatus": "planned",
                "validationStatus": "structural_check_planned",
            })
        checks.append(check)
    return checks


def review_row_analysis_check_payload(
    *,
    allowed_values,
    id_value,
    method,
    model_required,
    output,
    portable_model_path,
    raw_method,
    selected_model_artifact,
    target,
    total_rows,
):
    metrics = review_text_model_metrics(portable_model_path)
    return {
        "allowedValues": allowed_values if method == "one_of_values" else [],
        "executionMode": review_row_analysis_execution_mode(
            method,
            selected_model_artifact,
            portable_model_path,
            model_required,
        ),
        "fallbackUsed": method == "one_of_values" and not portable_model_path and not model_required,
        "id": id_value,
        "method": method,
        "metrics": metrics,
        "modelArtifact": os.path.basename(portable_model_path) if portable_model_path else "",
        "modelRequired": model_required,
        "output": output,
        "rawMethod": raw_method,
        "runtimeStatus": "recorded",
        "selectedModelArtifact": selected_model_artifact,
        "supportedMethods": sorted(REVIEW_ROW_ANALYSIS_SUPPORTED_METHODS),
        "target": target,
        "totalRows": total_rows,
        "validationRows": int(metrics.get("validationRows") or 0) if isinstance(metrics, dict) else 0,
    }


def review_row_analysis_execution_mode(method, selected_model_artifact, portable_model_path, model_required):
    if method in {"copy", "instruction"}:
        return method
    if method != "one_of_values":
        return ""
    if portable_model_path:
        return "selected_model" if selected_model_artifact else "auto_model"
    return "missing_model" if model_required else "fallback_rule"


def evaluate_review_row_analysis_checks(frame, steps, total_rows=None):
    review_steps = [
        step
        for step in steps
        if step
        and step.get("enabled") is not False
        and is_review_row_analysis_step(step)
    ]
    if not review_steps:
        return []

    checks = []
    total_rows = int(total_rows) if total_rows is not None else frame.count()
    for step in review_steps:
        step_output = normalize_column_name(step.get("output") or "")
        config = parse_review_row_analysis_config(str(step.get("params") or ""))
        target = normalize_column_name(config.get("outputColumn") or step_output)
        column_config = review_row_analysis_column_config(config, target)
        raw_method = str(
            column_config.get("method")
            or column_config.get("analysisMethod")
            or config.get("method")
            or config.get("analysisMethod")
            or ""
        )
        method = review_row_analysis_method(column_config, config)
        allowed_values = review_row_analysis_allowed_values(column_config, config)
        selected_model_artifact = review_row_analysis_model_artifact(column_config, config)
        portable_model_path = resolve_review_text_model_path(target, allowed_values, selected_model_artifact) if method == "one_of_values" else ""
        model_metrics = review_text_model_metrics(portable_model_path) if portable_model_path else {}
        fallback_allowed = review_row_analysis_fallback_allowed(config, column_config) if method == "one_of_values" else False
        model_selection_policy = review_row_analysis_model_selection_policy(column_config, config) if method == "one_of_values" else "none"
        model_required = review_text_model_required(config, column_config) if method == "one_of_values" else False
        resolved_output = resolve_column_name(frame, step_output or target)
        check = {
            "allowedValues": allowed_values if method == "one_of_values" else [],
            "executionMode": "pending",
            "fallbackAllowed": fallback_allowed,
            "fallbackUsed": False,
            "id": str(step.get("id") or target or step_output),
            "method": method,
            "metrics": model_metrics,
            "modelArtifact": os.path.basename(portable_model_path) if portable_model_path else "",
            "modelRequired": model_required,
            "modelSelectionPolicy": model_selection_policy,
            "resolvedModelArtifact": os.path.basename(portable_model_path) if portable_model_path else "",
            "selectedModelArtifact": selected_model_artifact,
            "output": step_output or target,
            "rawMethod": raw_method,
            "runtimeStatus": "recorded",
            "supportedMethods": sorted(REVIEW_ROW_ANALYSIS_SUPPORTED_METHODS),
            "target": target,
            "totalRows": total_rows,
            "validationRows": int(model_metrics.get("validationRows") or 0) if model_metrics else 0,
        }
        if not method:
            check.update({
                "invalidRows": total_rows,
                "runtimeStatus": "unsupported_method",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
            checks.append(check)
            continue
        if method == "one_of_values" and not allowed_values:
            check.update({
                "invalidRows": total_rows,
                "runtimeStatus": "missing_allowed_values",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
            checks.append(check)
            continue
        if method == "one_of_values" and model_required and not portable_model_path:
            check.update({
                "executionMode": "missing_model",
                "invalidRows": total_rows,
                "runtimeStatus": "missing_model_artifact",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
            checks.append(check)
            continue
        if not resolved_output:
            check.update({
                "invalidRows": total_rows,
                "runtimeStatus": "missing_output_column",
                "validRows": 0,
                "validationStatus": "needs_review",
            })
            checks.append(check)
            continue

        output_value = F.col(quote_identifier(resolved_output)).cast("string")
        expected_values = review_row_analysis_expected_values(method, allowed_values)
        if expected_values:
            valid_condition = output_value.isin(*expected_values)
        else:
            valid_condition = output_value.isNotNull() & (F.length(F.trim(output_value)) > 0)
        valid_rows = frame.filter(valid_condition).count()
        invalid_rows = max(total_rows - valid_rows, 0)
        output_distribution = []
        distinct_output_values = 0
        if method == "one_of_values":
            distribution_rows = (
                frame.select(output_value.alias("__review_value"))
                .groupBy("__review_value")
                .count()
                .orderBy(F.desc("count"))
                .limit(20)
                .collect()
            )
            output_distribution = [
                {
                    "count": int(row["count"]),
                    "value": "" if row["__review_value"] is None else str(row["__review_value"]),
                }
                for row in distribution_rows
            ]
            distinct_output_values = len([
                item
                for item in output_distribution
                if item.get("value") in expected_values
            ])
        if method == "one_of_values" and portable_model_path:
            runtime_status = "portable_text_model_output"
        elif method == "one_of_values":
            runtime_status = "rule_fallback_output"
        elif invalid_rows != 0:
            runtime_status = "needs_review"
        else:
            runtime_status = "valid_output"
        if portable_model_path:
            validation_status = "model_runtime_check"
        elif method == "one_of_values":
            validation_status = "fallback_structural_check_only"
        else:
            validation_status = "structural_check_only"
        if method == "one_of_values" and portable_model_path:
            execution_mode = review_row_analysis_execution_mode(
                method,
                selected_model_artifact,
                portable_model_path,
                model_required,
            )
            fallback_used = False
        elif method == "one_of_values":
            execution_mode = "fallback_rule"
            fallback_used = True
        else:
            execution_mode = method or "unsupported"
            fallback_used = False
        distribution_warning = ""
        if (
            method == "one_of_values"
            and len(expected_values) > 1
            and total_rows >= int(os.environ.get("ASKLAKE_TEXT_STRUCTURING_DISTRIBUTION_MIN_ROWS", "1000") or "1000")
            and distinct_output_values < 2
        ):
            distribution_warning = "single_value_output"
            runtime_status = "degenerate_model_output" if portable_model_path else "degenerate_fallback_output"
            validation_status = "distribution_check_failed"
        check.update({
            "distinctOutputValues": distinct_output_values,
            "distributionWarning": distribution_warning,
            "executionMode": execution_mode,
            "expectedValues": expected_values,
            "fallbackUsed": fallback_used,
            "invalidRows": invalid_rows,
            "outputDistribution": output_distribution,
            "runtimeStatus": runtime_status,
            "validRows": valid_rows,
            "validationStatus": validation_status,
        })
        checks.append(check)
    return checks


def text_structuring_manifest(transform_steps, checks):
    definition = text_structuring_definition_from_steps(transform_steps)
    return {
        "definition": definition,
        "execution": text_structuring_execution_summary(checks),
    }


def merge_text_structuring_quality(quality, frame, checks, output_path, total_rows=None):
    text_quality = evaluate_text_structuring_quality(frame, checks, total_rows=total_rows)
    if not text_quality:
        return quality
    quality["textStructuringQuality"] = text_quality
    if text_quality.get("invalidRows", 0) > 0:
        quarantine = write_text_structuring_quarantine(frame, checks, output_path, text_quality)
        if quarantine:
            quality["quarantine"] = quarantine
    current_invalid = int(quality.get("invalidRows") or 0)
    text_invalid = int(text_quality.get("invalidRows") or 0)
    invalid_rows = max(current_invalid, text_invalid)
    total = int(total_rows) if total_rows is not None else int(quality.get("sampleRows") or text_quality.get("totalRows") or 0)
    pass_rate = round(((total - invalid_rows) / total) * 100, 1) if total else 100.0
    distribution_warnings = text_quality.get("distributionWarnings") or []
    if invalid_rows > 0 or distribution_warnings:
        quality["invalidRows"] = invalid_rows
        quality["passRate"] = pass_rate
        quality["score"] = pass_rate
        if int(quality.get("blockingFailures") or 0) > 0:
            quality["status"] = "fail"
        elif quality.get("status") == "pass":
            quality["status"] = "warn"
        quality["summary"] = (
            f"Quality score {pass_rate}% - invalid rows {invalid_rows} - "
            f"text structuring warnings {len(distribution_warnings)}"
        )
    return quality


def evaluate_text_structuring_quality(frame, checks, total_rows=None):
    normalized_checks = [check for check in checks if isinstance(check, dict)]
    if not normalized_checks:
        return {}
    total = int(total_rows) if total_rows is not None else frame.count()
    invalid_condition = text_structuring_invalid_condition(frame, normalized_checks)
    invalid_rows = frame.filter(invalid_condition).count() if invalid_condition is not None else 0
    distribution_warnings = [
        {
            "column": str(check.get("target") or check.get("output") or check.get("id") or ""),
            "distinctOutputValues": int(check.get("distinctOutputValues") or 0),
            "reason": str(check.get("distributionWarning") or ""),
            "runtimeStatus": str(check.get("runtimeStatus") or ""),
        }
        for check in normalized_checks
        if check.get("distributionWarning")
    ]
    return {
        "distributionWarnings": distribution_warnings,
        "invalidRows": int(invalid_rows),
        "status": "warn" if invalid_rows or distribution_warnings else "pass",
        "totalRows": total,
    }


def text_structuring_invalid_condition(frame, checks):
    invalid_condition = None
    for check in checks:
        target_column = str(check.get("target") or check.get("output") or "")
        resolved_output = resolve_column_name(frame, target_column)
        if not resolved_output:
            continue
        output_value = F.col(quote_identifier(resolved_output)).cast("string")
        expected_values = check.get("expectedValues") or check.get("allowedValues") or []
        if expected_values:
            condition = output_value.isNull() | (~output_value.isin(*[str(value) for value in expected_values]))
        else:
            condition = output_value.isNull() | (F.length(F.trim(output_value)) == 0)
        invalid_condition = condition if invalid_condition is None else invalid_condition | condition
    return invalid_condition


def write_text_structuring_quarantine(frame, checks, output_path, text_quality):
    invalid_rows = int(text_quality.get("invalidRows") or 0)
    if invalid_rows <= 0:
        return {}
    invalid_condition = text_structuring_invalid_condition(frame, checks)
    if invalid_condition is None:
        return {}
    quarantine_path = f"{str(output_path).rstrip('/')}_quarantine"
    (
        frame.filter(invalid_condition)
        .withColumn("_asklake_quarantine_reason", F.lit("text_structuring_invalid_output"))
        .write.mode("overwrite")
        .parquet(quarantine_path)
    )
    return {
        "format": "parquet",
        "path": quarantine_path,
        "reason": "text_structuring_invalid_output",
        "rows": invalid_rows,
    }


def text_structuring_definition_from_steps(transform_steps):
    columns = []
    seen = set()
    source_fields = []
    for step in transform_steps:
        if not step or step.get("enabled") is False or not is_review_row_analysis_step(step):
            continue
        config = parse_review_row_analysis_config(str(step.get("params") or ""))
        source_field = str(config.get("sourceField") or step.get("input") or "text")
        if source_field not in source_fields:
            source_fields.append(source_field)
        raw_columns = config.get("columns")
        if not isinstance(raw_columns, list):
            raw_columns = [review_row_analysis_column_config(config, normalize_column_name(step.get("output") or "")) or {}]
        for raw_column in raw_columns:
            if not isinstance(raw_column, dict):
                continue
            target = normalize_column_name(raw_column.get("targetName") or raw_column.get("name") or step.get("output") or "")
            if not target or target in seen:
                continue
            method = review_row_analysis_method(raw_column, config)
            allowed_values = review_row_analysis_allowed_values(raw_column, config) if method == "one_of_values" else []
            seen.add(target)
            columns.append({
                "allowedValues": allowed_values,
                "fallbackAllowed": review_row_analysis_fallback_allowed(config, raw_column) if method == "one_of_values" else False,
                "method": method,
                "modelArtifact": review_row_analysis_model_artifact(raw_column, config) if method == "one_of_values" else "",
                "modelSelectionPolicy": review_row_analysis_model_selection_policy(raw_column, config) if method == "one_of_values" else "none",
                "requireModel": review_text_model_required(config, raw_column) if method == "one_of_values" else False,
                "sourceField": source_field,
                "targetName": target,
                "type": str(raw_column.get("type") or "String"),
            })
    return {
        "columns": columns,
        "sourceFields": source_fields,
        "version": 1,
    }


def text_structuring_execution_summary(checks):
    normalized_checks = checks if isinstance(checks, list) else []
    columns = []
    for check in normalized_checks:
        if not isinstance(check, dict):
            continue
        target = str(check.get("target") or check.get("output") or "")
        columns.append({
            "allowedValues": check.get("allowedValues") or [],
            "distinctOutputValues": int(check.get("distinctOutputValues") or 0),
            "distributionWarning": check.get("distributionWarning") or "",
            "executionMode": check.get("executionMode") or "",
            "fallbackAllowed": bool(check.get("fallbackAllowed")),
            "fallbackUsed": bool(check.get("fallbackUsed")),
            "invalidRows": int(check.get("invalidRows") or 0),
            "method": check.get("method") or "",
            "metrics": check.get("metrics") or {},
            "modelArtifact": check.get("modelArtifact") or "",
            "modelRequired": bool(check.get("modelRequired")),
            "outputDistribution": check.get("outputDistribution") or [],
            "modelSelectionPolicy": check.get("modelSelectionPolicy") or "",
            "runtimeStatus": check.get("runtimeStatus") or "",
            "selectedModelArtifact": check.get("selectedModelArtifact") or "",
            "target": target,
            "targetColumn": target,
            "validationStatus": check.get("validationStatus") or "",
            "validationRows": int(check.get("validationRows") or 0),
        })
    return {
        "columns": columns,
        "fallbackColumns": [item["targetColumn"] for item in columns if item.get("fallbackUsed")],
        "missingModelColumns": [item["targetColumn"] for item in columns if item.get("runtimeStatus") == "missing_model_artifact"],
        "modelColumns": [item["targetColumn"] for item in columns if item.get("executionMode") in {"selected_model", "auto_model"}],
        "oneOfValueColumns": sum(1 for item in columns if item.get("method") == "one_of_values"),
        "totalColumns": len(columns),
    }


def is_review_row_analysis_step(step):
    operation = str(step.get("operation") or step.get("kind") or "").lower()
    return is_row_analysis_operation(operation)


def is_row_analysis_operation(operation):
    normalized = str(operation or "").lower()
    return (
        "review row analysis" in normalized
        or "text row analysis" in normalized
        or "review_analyze" in normalized
        or "text_analyze" in normalized
    )


def review_row_analysis_expected_values(method, allowed_values):
    if method == "one_of_values":
        return allowed_values
    return []


def custom_csv_classifier_expression(source, params):
    config = parse_custom_csv_classifier_config(params)
    rules = config.get("rules") or []
    fallback = next((rule.get("value") for rule in rules if rule.get("condition") == "else"), None)
    fallback = fallback or config.get("fallbackValue") or (rules[-1].get("value") if rules else "")
    expression = None
    for rule in rules:
        if rule.get("condition") == "else":
            continue
        condition = custom_csv_classifier_condition(source, rule)
        if condition is None:
            continue
        value = F.lit(str(rule.get("value") or ""))
        expression = F.when(condition, value) if expression is None else expression.when(condition, value)
    if expression is None:
        return F.lit(str(fallback))
    return expression.otherwise(F.lit(str(fallback)))


def parse_custom_csv_classifier_config(params):
    try:
        parsed = json.loads(params or "{}")
    except Exception:
        parsed = {}
    raw_rules = parsed.get("rules") if isinstance(parsed, dict) else []
    rules = []
    if isinstance(raw_rules, list):
        for rule in raw_rules:
            if not isinstance(rule, dict):
                continue
            value = str(rule.get("value") or "").strip()
            if not value:
                continue
            rules.append({
                "condition": str(rule.get("condition") or "keyword_any"),
                "pattern": str(rule.get("pattern") or ""),
                "value": value,
            })
    return {
        "fallbackValue": str(parsed.get("fallbackValue") or "") if isinstance(parsed, dict) else "",
        "rules": rules,
    }


def custom_csv_classifier_condition(source, rule):
    condition = str(rule.get("condition") or "keyword_any")
    pattern = str(rule.get("pattern") or "")
    text_value = source.cast("string")
    lowered = F.lower(text_value)
    if condition == "empty":
        return source.isNull() | (F.length(F.trim(text_value)) == 0)
    if condition == "not_empty":
        return source.isNotNull() & (F.length(F.trim(text_value)) > 0)
    if condition == "numeric_lte":
        return source.cast("double") <= safe_float(pattern)
    if condition == "numeric_gte":
        return source.cast("double") >= safe_float(pattern)
    keywords = [item.strip().lower() for item in pattern.split(",") if item.strip()]
    if not keywords:
        return None
    checks = [lowered.contains(keyword) for keyword in keywords]
    current = checks[0]
    for check in checks[1:]:
        current = current & check if condition == "keyword_all" else current | check
    return current


def evaluate_custom_csv_classifier_checks(frame, steps, total_rows=None):
    classifier_steps = [
        step
        for step in steps
        if step
        and step.get("enabled") is not False
        and is_custom_csv_classifier_step(step)
    ]
    if not classifier_steps:
        return []

    checks = []
    total_rows = int(total_rows) if total_rows is not None else frame.count()
    for step in classifier_steps:
        input_column = str(step.get("input") or "").strip()
        output_column = normalize_column_name(step.get("output") or input_column)
        config = parse_custom_csv_classifier_config(str(step.get("params") or ""))
        rules = config.get("rules") or []
        fallback = custom_csv_classifier_fallback(config)
        resolved_output = resolve_column_name(frame, output_column)
        blank_pattern_rules = [
            rule
            for rule in rules
            if classifier_condition_needs_pattern(rule.get("condition")) and not str(rule.get("pattern") or "").strip()
        ]
        invalid_numeric_rules = [
            rule
            for rule in rules
            if classifier_numeric_condition(rule.get("condition")) and not classifier_pattern_is_number(rule.get("pattern"))
        ]

        check = {
            "blankPatternRules": len(blank_pattern_rules),
            "fallbackValue": fallback,
            "id": str(step.get("id") or output_column),
            "input": input_column,
            "invalidNumericRules": len(invalid_numeric_rules),
            "output": output_column,
            "rules": len(rules),
            "runtimeStatus": "recorded",
            "totalRows": total_rows,
        }
        if not resolved_output:
            check["runtimeStatus"] = "missing_output_column"
            checks.append(check)
            continue

        output_value = F.col(quote_identifier(resolved_output)).cast("string")
        fallback_rows = frame.filter(output_value == F.lit(str(fallback))).count() if fallback != "" else 0
        distribution_rows = (
            frame.select(output_value.alias("__classifier_value"))
            .groupBy("__classifier_value")
            .count()
            .orderBy(F.desc("count"))
            .limit(20)
            .collect()
        )
        check.update({
            "explicitRows": max(total_rows - fallback_rows, 0),
            "fallbackRows": fallback_rows,
            "outputDistribution": [
                {
                    "count": int(row["count"]),
                    "value": "" if row["__classifier_value"] is None else str(row["__classifier_value"]),
                }
                for row in distribution_rows
            ],
        })
        if blank_pattern_rules or invalid_numeric_rules:
            check["runtimeStatus"] = "rules_need_attention"
        checks.append(check)
    return checks


def is_custom_csv_classifier_step(step):
    operation = str(step.get("operation") or step.get("kind") or "").lower()
    return "custom csv classifier" in operation or "csv classifier" in operation


def custom_csv_classifier_fallback(config):
    rules = config.get("rules") or []
    fallback = next((rule.get("value") for rule in rules if rule.get("condition") == "else"), None)
    return str(fallback or config.get("fallbackValue") or (rules[-1].get("value") if rules else ""))


def classifier_condition_needs_pattern(condition):
    return str(condition or "keyword_any") not in {"else", "empty", "not_empty"}


def classifier_numeric_condition(condition):
    return str(condition or "") in {"numeric_lte", "numeric_gte"}


def classifier_pattern_is_number(pattern):
    try:
        float(str(pattern or "").strip())
        return True
    except Exception:
        return False


def safe_float(value):
    try:
        return float(value)
    except Exception:
        return 0.0


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


def safe_col(frame, name):
    resolved = resolve_column_name(frame, name)
    if resolved:
        return F.col(quote_identifier(resolved))
    return F.lit("")


def try_cast_double(frame, name):
    resolved = resolve_column_name(frame, name)
    if not resolved:
        return F.lit(None).cast("double")
    return F.expr(f"try_cast({quote_identifier(resolved)} as double)")


def resolve_column_name(frame, name):
    if name in frame.columns:
        return name
    normalized = normalize_column_name(name)
    if normalized in frame.columns:
        return normalized
    return ""


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


def quote_identifier(name):
    return f"`{str(name).replace('`', '``')}`"


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


def normalize_column_name(value):
    text = "".join(char if char.isalnum() or char == "_" else "_" for char in str(value).strip().lower())
    while "__" in text:
        text = text.replace("__", "_")
    return text.strip("_")


def truncate_text(value, length):
    text = str(value or "")
    if len(text) <= length:
        return text
    return text[: max(length - 1, 0)] + "..."


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def load_json_env(name, fallback):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    value = json.loads(raw.lstrip("\ufeff"))
    return value if isinstance(value, list) else fallback


def load_spark_job_manifest():
    path = os.environ.get("ASKLAKE_SPARK_JOB_MANIFEST_FILE") or os.environ.get("ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE")
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return manifest if isinstance(manifest, dict) else {}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_report(path, result):
    if not path:
        return
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
