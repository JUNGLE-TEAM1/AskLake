import json
import os
import sys
import time
import hashlib
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T


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
TEXT_STRUCTURING_CACHE = OrderedDict()


def main():
    started_at = now_iso()
    started_ms = int(time.time() * 1000)
    report_file = os.environ.get("ASKLAKE_SPARK_REPORT_FILE")
    source_path = os.environ.get("ASKLAKE_SPARK_SOURCE_PATH", "-")
    source_format = os.environ.get("ASKLAKE_SPARK_SOURCE_FORMAT", "unknown").lower()
    output_path = os.environ.get("ASKLAKE_SPARK_OUTPUT_PATH", "-")
    run_id = os.environ.get("ASKLAKE_SPARK_RUN_ID", "unknown")
    spark = None
    try:
        source_path = required_env("ASKLAKE_SPARK_SOURCE_PATH")
        source_format = required_env("ASKLAKE_SPARK_SOURCE_FORMAT").lower()
        output_path = required_env("ASKLAKE_SPARK_OUTPUT_PATH")
        run_id = required_env("ASKLAKE_SPARK_RUN_ID")
        row_limit = int(os.environ.get("ASKLAKE_SPARK_RUN_ROW_LIMIT", "0") or "0")
        schema_columns = load_json_env("ASKLAKE_SPARK_SCHEMA_COLUMNS", [])
        transform_steps = load_json_env("ASKLAKE_SPARK_TRANSFORM_STEPS", [])
        quality_rules = load_json_env("ASKLAKE_SPARK_QUALITY_RULES", [])
        job_manifest = load_json_file(os.environ.get("ASKLAKE_SPARK_JOB_MANIFEST"), {})
        text_structuring = job_manifest.get("textStructuring") if isinstance(job_manifest, dict) else None
        spark = make_spark()
        source_df = read_source(spark, source_format, source_path, schema_columns)
        input_rows = source_df.count() if row_limit <= 0 else source_df.limit(row_limit).count()
        working_df = source_df if row_limit <= 0 else source_df.limit(row_limit)
        normalized_df = normalize_columns(working_df)
        contracted_df = apply_schema_contract(normalized_df, schema_columns, transform_steps)
        transformed_df = apply_transform_steps(spark, contracted_df, transform_steps)
        selected_df = select_final_schema_columns(transformed_df, schema_columns)
        repeated_frames = []
        quarantine_frame = None
        if text_structuring:
            structured_df = apply_text_structuring_partition_batches(
                spark,
                selected_df,
                text_structuring,
                run_id,
            ).cache()
            structured_df.count()
            output_frame, repeated_frames, quarantine_frame = split_text_structuring_artifacts(
                structured_df,
                text_structuring.get("definition") or {},
            )
        else:
            output_frame = selected_df
        output_frame = output_frame.cache()
        output_frame.count()
        quality = evaluate_quality_rules(output_frame, quality_rules)
        classifier_checks = evaluate_custom_csv_classifier_checks(output_frame, transform_steps)
        if classifier_checks:
            quality["classifierChecks"] = classifier_checks
        review_analysis_checks = evaluate_review_row_analysis_checks(output_frame, transform_steps)
        if review_analysis_checks:
            quality["reviewRowAnalysisChecks"] = review_analysis_checks
        if text_structuring:
            quality["textStructuring"] = text_structuring_quality_summary(
                structured_df,
                text_structuring,
            )
        if quality["status"] == "fail":
            ended_at = now_iso()
            result = {
                "durationMs": int(time.time() * 1000) - started_ms,
                "endedAt": ended_at,
                "error": quality["summary"],
                "failedStage": "Quality",
                "format": source_format,
                "inputRows": input_rows,
                "outputPath": output_path,
                "outputRows": 0,
                "quality": quality,
                "runId": run_id,
                "sourcePath": source_path,
                "startedAt": started_at,
                "status": "failed",
            }
            write_report(report_file, result)
            print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
            return 1

        output_df = output_frame.withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
            "_asklake_ingested_at",
            F.current_timestamp(),
        )
        output_df.write.mode("overwrite").parquet(output_path)
        output_rows = spark.read.parquet(output_path).count()
        artifacts = [artifact_report("main", "main", output_path, output_df, output_rows)]
        for group_name, repeated_frame in repeated_frames:
            repeated_path = artifact_output_path(output_path, group_name)
            repeated_output = repeated_frame.withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
                "_asklake_ingested_at",
                F.current_timestamp(),
            )
            repeated_output.write.mode("overwrite").parquet(repeated_path)
            repeated_rows = spark.read.parquet(repeated_path).count()
            artifacts.append(artifact_report("repeated_group", group_name, repeated_path, repeated_output, repeated_rows))
        if quarantine_frame is not None:
            quarantine_path = artifact_output_path(output_path, "quarantine")
            quarantine_output = quarantine_frame.withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
                "_asklake_ingested_at",
                F.current_timestamp(),
            )
            quarantine_output.write.mode("overwrite").parquet(quarantine_path)
            quarantine_rows = spark.read.parquet(quarantine_path).count()
            artifacts.append(artifact_report("quarantine", "quarantine", quarantine_path, quarantine_output, quarantine_rows))
        ended_at = now_iso()
        result = {
            "artifacts": artifacts,
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "format": source_format,
            "inputRows": input_rows,
            "outputPath": output_path,
            "outputRows": output_rows,
            "quality": quality,
            "runId": run_id,
            "schema": [
                {
                    "name": field.name,
                    "nullable": field.nullable,
                    "type": field.dataType.simpleString(),
                }
                for field in output_df.schema.fields
            ],
            "sourcePath": source_path,
            "startedAt": started_at,
            "status": "success",
        }
        write_report(report_file, result)
        print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
        return 0
    except Exception as exc:
        ended_at = now_iso()
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "error": str(exc),
            "format": source_format,
            "inputRows": 0,
            "outputPath": output_path,
            "outputRows": 0,
            "runId": run_id,
            "sourcePath": source_path,
            "startedAt": started_at,
            "status": "failed",
        }
        write_report(report_file, result)
        print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
        print(f"Spark job failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if spark is not None:
            spark.stop()


def apply_text_structuring_partition_batches(spark, frame, text_structuring, run_id):
    definition = text_structuring.get("definition") if isinstance(text_structuring, dict) else None
    spec_ref = text_structuring.get("specRef") if isinstance(text_structuring, dict) else None
    if not isinstance(definition, dict) or not isinstance(spec_ref, dict):
        raise ValueError("Text structuring manifest requires definition and specRef.")
    fingerprint = str(spec_ref.get("fingerprint") or "").strip()
    if not fingerprint:
        raise ValueError("Text structuring manifest fingerprint is missing.")

    prepared = ensure_text_structuring_source_row_id(frame)
    output_schema = text_structuring_output_schema(prepared.schema, definition)
    batch_size = max(1, min(int((definition.get("routingPolicy") or {}).get("batchSize") or 32), 512))
    on_error = str((definition.get("routingPolicy") or {}).get("onError") or "quarantine")
    job_id = str(text_structuring.get("jobId") or "") or None

    def map_partition(rows):
        return structure_text_partition(
            rows,
            definition=definition,
            spec_ref=spec_ref,
            run_id=run_id,
            job_id=job_id,
            batch_size=batch_size,
            on_error=on_error,
        )

    return spark.createDataFrame(prepared.rdd.mapPartitions(map_partition), schema=output_schema)


def ensure_text_structuring_source_row_id(frame):
    if "_asklake_source_row_id" in frame.columns:
        return frame
    payload_columns = [F.col(quote_identifier(name)).alias(name) for name in sorted(frame.columns)]
    row_hash = F.sha2(F.to_json(F.struct(*payload_columns)), 256)
    unique_suffix = F.monotonically_increasing_id().cast("string")
    return frame.withColumn(
        "_asklake_source_row_id",
        F.concat(F.lit("row_"), row_hash, F.lit("_"), unique_suffix),
    )


def text_structuring_output_schema(base_schema, definition):
    output_fields = definition.get("fields") if isinstance(definition.get("fields"), list) else []
    repeated_groups = definition.get("repeatedGroups") if isinstance(definition.get("repeatedGroups"), list) else []
    reserved = {
        str(field.get("targetName") or "")
        for field in output_fields
        if isinstance(field, dict) and field.get("targetName")
    }
    reserved.update(
        str(group.get("targetName") or "")
        for group in repeated_groups
        if isinstance(group, dict) and group.get("targetName")
    )
    reserved.update({
        "_asklake_review_required",
        "_asklake_review_reasons",
        "_asklake_route",
        "_asklake_error",
        "_asklake_spec_fingerprint",
    })
    fields = [field for field in base_schema.fields if field.name not in reserved]
    for field in output_fields:
        if not isinstance(field, dict) or not field.get("targetName"):
            continue
        fields.append(T.StructField(str(field["targetName"]), spark_type_for_text_field(field), True))
    for group in repeated_groups:
        if not isinstance(group, dict) or not group.get("targetName"):
            continue
        children = group.get("fields") if isinstance(group.get("fields"), list) else []
        item_schema = T.StructType([
            T.StructField(str(field.get("targetName")), spark_type_for_text_field(field), True)
            for field in children
            if isinstance(field, dict) and field.get("targetName")
        ])
        fields.append(T.StructField(str(group["targetName"]), T.ArrayType(item_schema, True), True))
    fields.extend([
        T.StructField("_asklake_review_required", T.BooleanType(), False),
        T.StructField("_asklake_review_reasons", T.ArrayType(T.StringType(), False), False),
        T.StructField("_asklake_route", T.StringType(), False),
        T.StructField("_asklake_error", T.StringType(), True),
        T.StructField("_asklake_spec_fingerprint", T.StringType(), False),
    ])
    return T.StructType(fields)


def spark_type_for_text_field(field):
    task = str(field.get("task") or "")
    output_type = str(field.get("outputType") or "string").lower()
    if task == "multi_label":
        return T.ArrayType(T.StringType(), False)
    if task == "boolean" or output_type in {"bool", "boolean"}:
        return T.BooleanType()
    if task == "extract_scalar" or any(token in output_type for token in ("int", "float", "double", "decimal", "number")):
        return T.DoubleType()
    return T.StringType()


def structure_text_partition(rows, *, definition, spec_ref, run_id, job_id, batch_size, on_error):
    batch = []
    for row in rows:
        batch.append(row.asDict(recursive=True))
        if len(batch) >= batch_size:
            yield from structure_text_batch(
                batch,
                definition=definition,
                spec_ref=spec_ref,
                run_id=run_id,
                job_id=job_id,
                on_error=on_error,
            )
            batch = []
    if batch:
        yield from structure_text_batch(
            batch,
            definition=definition,
            spec_ref=spec_ref,
            run_id=run_id,
            job_id=job_id,
            on_error=on_error,
        )


def structure_text_batch(batch, *, definition, spec_ref, run_id, job_id, on_error):
    fingerprint = str(spec_ref.get("fingerprint") or "")
    source_fields = definition.get("sourceFields") if isinstance(definition.get("sourceFields"), list) else []
    results_by_id = {}
    uncached_rows = []
    cache_keys = {}
    for row in batch:
        source_row_id = str(row.get("_asklake_source_row_id") or "")
        cache_payload = {field: row.get(field) for field in source_fields}
        cache_key = hashlib.sha256(
            f"{fingerprint}:{json.dumps(cache_payload, ensure_ascii=False, sort_keys=True, default=str)}".encode("utf-8")
        ).hexdigest()
        cache_keys[source_row_id] = cache_key
        cached = text_structuring_cache_get(cache_key)
        if cached is not None:
            results_by_id[source_row_id] = {**cached, "sourceRowId": source_row_id}
        else:
            uncached_rows.append({**row, "sourceRowId": source_row_id})

    if uncached_rows:
        try:
            response = call_text_structuring_batch_api(
                definition=definition,
                spec_ref=spec_ref,
                rows=uncached_rows,
                run_id=run_id,
                job_id=job_id,
            )
            response_rows = response.get("rows") if isinstance(response, dict) else None
            if not isinstance(response_rows, list):
                raise ValueError("Text structuring batch response did not contain rows.")
            for result in response_rows:
                if not isinstance(result, dict):
                    continue
                source_row_id = str(result.get("sourceRowId") or "")
                if not source_row_id:
                    continue
                results_by_id[source_row_id] = result
                cache_key = cache_keys.get(source_row_id)
                if cache_key:
                    text_structuring_cache_put(cache_key, {key: value for key, value in result.items() if key != "sourceRowId"})
        except Exception as exc:
            if on_error == "fail":
                raise
            error = truncate_text(str(exc), 1000)
            for row in batch:
                source_row_id = str(row.get("_asklake_source_row_id") or "")
                if source_row_id not in results_by_id:
                    results_by_id[source_row_id] = text_structuring_error_result(
                        definition,
                        source_row_id,
                        error,
                        on_error,
                    )

    for row in batch:
        source_row_id = str(row.get("_asklake_source_row_id") or "")
        result = results_by_id.get(source_row_id)
        if result is None:
            if on_error == "fail":
                raise ValueError(f"Text structuring response omitted row {source_row_id}.")
            result = text_structuring_error_result(
                definition,
                source_row_id,
                "Text structuring response omitted this row.",
                on_error,
            )
        yield merge_text_structuring_result(row, result, definition, fingerprint)


def call_text_structuring_batch_api(*, definition, spec_ref, rows, run_id, job_id=None):
    endpoint = os.environ.get(
        "ASKLAKE_TEXT_STRUCTURING_BATCH_URL",
        "http://host.docker.internal:8080/api/internal/text-structuring/batch",
    )
    token = os.environ.get("ASKLAKE_TEXT_STRUCTURING_INTERNAL_TOKEN", "")
    payload = {
        "definition": definition,
        "rows": rows,
        "runId": run_id,
        "jobId": job_id,
        "specRef": spec_ref,
    }
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-AskLake-Internal-Token"] = token
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    timeout = max(1, int(os.environ.get("ASKLAKE_TEXT_STRUCTURING_TIMEOUT_SECONDS", "180") or "180"))
    attempts = max(1, int(os.environ.get("ASKLAKE_TEXT_STRUCTURING_MAX_ATTEMPTS", "3") or "3"))
    last_error = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(min(2 ** attempt, 8))
    raise ValueError(f"Text structuring batch call failed after {attempts} attempts: {last_error}")


def merge_text_structuring_result(row, result, definition, fingerprint):
    merged = dict(row)
    output = result.get("output") if isinstance(result.get("output"), dict) else {}
    repeated = result.get("repeatedGroups") if isinstance(result.get("repeatedGroups"), dict) else {}
    for field in definition.get("fields") or []:
        if not isinstance(field, dict) or not field.get("targetName"):
            continue
        target = str(field["targetName"])
        value = output.get(target)
        if value is None and field.get("task") == "copy":
            value = row.get(field.get("sourceField") or target)
        merged[target] = normalize_text_field_value(field, value)
    for group in definition.get("repeatedGroups") or []:
        if not isinstance(group, dict) or not group.get("targetName"):
            continue
        target = str(group["targetName"])
        raw_items = repeated.get(target)
        merged[target] = [
            {
                str(field.get("targetName")): normalize_text_field_value(
                    field,
                    item.get(str(field.get("targetName"))),
                )
                for field in group.get("fields") or []
                if isinstance(field, dict) and field.get("targetName")
            }
            for item in raw_items
            if isinstance(item, dict)
        ] if isinstance(raw_items, list) else []
    merged["_asklake_review_required"] = bool(result.get("reviewRequired"))
    merged["_asklake_review_reasons"] = [str(reason) for reason in result.get("reviewReasons") or []]
    merged["_asklake_route"] = str(result.get("route") or "unknown")
    merged["_asklake_error"] = str(result.get("error")) if result.get("error") else None
    merged["_asklake_spec_fingerprint"] = fingerprint
    return merged


def normalize_text_field_value(field, value):
    data_type = spark_type_for_text_field(field)
    if value is None:
        return [] if isinstance(data_type, T.ArrayType) else None
    if isinstance(data_type, T.ArrayType):
        return [str(item) for item in value] if isinstance(value, list) else [str(value)]
    if isinstance(data_type, T.BooleanType):
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"true", "1", "yes", "y"}
    if isinstance(data_type, T.DoubleType):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    return str(value)


def text_structuring_error_result(definition, source_row_id, error, on_error):
    output = {}
    for field in definition.get("fields") or []:
        if not isinstance(field, dict) or not field.get("targetName"):
            continue
        output[str(field["targetName"])] = [] if field.get("task") == "multi_label" else None
    repeated = {
        str(group.get("targetName")): []
        for group in definition.get("repeatedGroups") or []
        if isinstance(group, dict) and group.get("targetName")
    }
    return {
        "sourceRowId": source_row_id,
        "output": output,
        "repeatedGroups": repeated,
        "reviewRequired": True,
        "reviewReasons": [error],
        "route": "error_keep_raw" if on_error == "keep_raw" else "quarantine_error",
        "error": error,
    }


def text_structuring_cache_get(key):
    value = TEXT_STRUCTURING_CACHE.get(key)
    if value is not None:
        TEXT_STRUCTURING_CACHE.move_to_end(key)
    return value


def text_structuring_cache_put(key, value):
    TEXT_STRUCTURING_CACHE[key] = value
    TEXT_STRUCTURING_CACHE.move_to_end(key)
    max_entries = max(0, int(os.environ.get("ASKLAKE_TEXT_STRUCTURING_CACHE_ENTRIES", "10000") or "10000"))
    while max_entries and len(TEXT_STRUCTURING_CACHE) > max_entries:
        TEXT_STRUCTURING_CACHE.popitem(last=False)


def split_text_structuring_artifacts(frame, definition):
    route = F.col("_asklake_route")
    quarantine = frame.filter(route.startswith("quarantine"))
    valid = frame.filter(~route.startswith("quarantine"))
    repeated_frames = []
    child_group_names = []
    for group in definition.get("repeatedGroups") or []:
        if not isinstance(group, dict) or group.get("outputMode") != "child_table":
            continue
        group_name = str(group.get("targetName") or "").strip()
        if not group_name or group_name not in valid.columns:
            continue
        child_group_names.append(group_name)
        exploded = valid.select(
            F.col("_asklake_source_row_id"),
            F.col("_asklake_route"),
            F.explode(F.col(quote_identifier(group_name))).alias("_asklake_item"),
        )
        child_fields = [
            F.col(f"_asklake_item.{quote_identifier(str(field.get('targetName')))}").alias(str(field.get("targetName")))
            for field in group.get("fields") or []
            if isinstance(field, dict) and field.get("targetName")
        ]
        repeated_frames.append((group_name, exploded.select(
            F.col("_asklake_source_row_id"),
            *child_fields,
            F.col("_asklake_route"),
        )))
    main = valid.drop(*child_group_names) if child_group_names else valid
    return main, repeated_frames, quarantine


def text_structuring_quality_summary(frame, text_structuring):
    total_rows = frame.count()
    review_rows = frame.filter(F.col("_asklake_review_required") == F.lit(True)).count()
    quarantine_rows = frame.filter(F.col("_asklake_route").startswith("quarantine")).count()
    distribution = {
        str(row["_asklake_route"]): int(row["count"])
        for row in frame.groupBy("_asklake_route").count().collect()
    }
    return {
        "fingerprint": ((text_structuring.get("specRef") or {}).get("fingerprint")),
        "quarantineRows": quarantine_rows,
        "reviewRate": (review_rows / total_rows) if total_rows else 0,
        "reviewRows": review_rows,
        "routeDistribution": distribution,
        "specId": ((text_structuring.get("specRef") or {}).get("specId")),
        "specVersion": ((text_structuring.get("specRef") or {}).get("version")),
        "totalRows": total_rows,
    }


def artifact_output_path(output_path, name):
    return f"{str(output_path).rstrip('/')}__{normalize_column_name(name) or 'artifact'}"


def artifact_report(kind, name, path, frame, row_count):
    return {
        "kind": kind,
        "name": name,
        "path": path,
        "rows": int(row_count),
        "schema": [
            {
                "name": field.name,
                "nullable": field.nullable,
                "type": field.dataType.simpleString(),
            }
            for field in frame.schema.fields
        ],
    }


def make_spark():
    endpoint = os.environ.get("MINIO_ENDPOINT", "http://m3-minio:9000")
    access_key = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("MINIO_ROOT_USER", "")
    secret_key = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("MINIO_ROOT_PASSWORD", "")
    region = os.environ.get("MINIO_REGION", "us-east-1")
    ssl_enabled = os.environ.get("MINIO_SSL_ENABLED")
    if ssl_enabled is None:
        ssl_enabled = "true" if endpoint.lower().startswith("https://") else "false"

    spark = (
        SparkSession.builder.appName(os.environ.get("ASKLAKE_SPARK_APP_NAME", "asklake-pipeline-run"))
        .config("spark.sql.caseSensitive", "true")
        .config("spark.hadoop.fs.s3a.endpoint", endpoint)
        .config("spark.hadoop.fs.s3a.access.key", access_key)
        .config("spark.hadoop.fs.s3a.secret.key", secret_key)
        .config("spark.hadoop.fs.s3a.endpoint.region", region)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", ssl_enabled)
        .config("spark.hadoop.fs.s3a.aws.credentials.provider", "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("INFO")
    return spark


def read_source(spark, source_format, source_path, schema_columns):
    if source_format == "csv":
        infer_schema = "false" if schema_columns else "true"
        return spark.read.option("header", "true").option("inferSchema", infer_schema).csv(source_path)
    if source_format == "jsonl":
        return spark.read.option("multiLine", "false").json(source_path)
    if source_format == "json":
        return spark.read.option("multiLine", "true").json(source_path)
    if source_format == "parquet":
        return spark.read.parquet(source_path)
    if source_format in {"txt", "text"}:
        return spark.read.text(source_path)
    raise ValueError(f"Unsupported Spark source format: {source_format}")


def apply_schema_contract(frame, schema_columns, transform_steps=None):
    if not schema_columns:
        return frame

    included_columns = [column for column in schema_columns if schema_column_included(column)]
    if not included_columns:
        raise ValueError("Approved schema has no included output columns.")

    expressions = []
    missing_required = []
    required_targets = []
    used_names = set()
    for index, column in enumerate(included_columns):
        source_name = str(column.get("sourceName") or column.get("targetName") or "").strip()
        target_name = unique_column_name(normalize_column_name(column.get("targetName") or source_name) or f"column_{index + 1}", used_names)
        logical_type = str(column.get("type") or "String")
        nullable = bool(column.get("nullable", True))
        resolved = resolve_column_name(frame, source_name) or resolve_column_name(frame, target_name)
        if not resolved:
            if nullable:
                expressions.append(F.lit(None).cast(spark_sql_type(logical_type)).alias(target_name))
            else:
                missing_required.append(source_name or target_name)
            continue
        if not nullable:
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
    contracted = frame.select(*expressions)
    null_required = [
        target
        for target in required_targets
        if contracted.filter(F.col(quote_identifier(target)).isNull()).limit(1).count() > 0
    ]
    if null_required:
        raise ValueError(f"Approved schema required columns produced null values after casting: {', '.join(null_required)}")
    return contracted


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
        return review_one_of_values_expression(
            frame,
            target,
            review_row_analysis_allowed_values(column_config, config),
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
    if method == "instruction":
        return review_instruction_expression(target, column_config, title, text)
    return F.lit("")


def review_instruction_expression(target, column_config, title, text):
    instruction = str(column_config.get("instruction") or column_config.get("description") or "").lower()
    normalized_target = normalize_column_name(target)
    combined = F.regexp_replace(F.concat_ws(" ", title, text), r"\s+", " ")
    haystack = F.lower(combined)
    if normalized_target in {"sentiment", "overall_sentiment"} or (
        "positive" in instruction and "negative" in instruction
    ):
        return review_text_sentiment_expression(haystack)
    if normalized_target in {"severity", "issue_severity"} or "high" in instruction and "medium" in instruction:
        return review_text_severity_expression(haystack)
    if "aspect" in normalized_target or "aspect" in instruction:
        return review_text_aspects_expression(haystack)
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


def review_text_sentiment_expression(haystack):
    negative = haystack.rlike(
        "bad|worst|disappoint|waste|hate|awful|terrible|poor|not work|doesn.t work|broke|defect|"
        "irritat|rash|breakout|acne|allerg|burn|refund|return|leak|greasy|sticky"
    )
    positive = haystack.rlike(
        "good|great|love|best|excellent|perfect|amazing|recommend|favorite|works well|soft|smooth|"
        "moisturi[sz]|hydrate|glow|beautiful"
    )
    return (
        F.when(negative & positive, F.lit("mixed"))
        .when(negative, F.lit("negative"))
        .when(positive, F.lit("positive"))
        .otherwise(F.lit("neutral"))
    )


def review_text_severity_expression(haystack):
    high = haystack.rlike(
        "rash|breakout|acne|allerg|burn|swelling|hives|refund|return|unsafe|blood|hospital|"
        "not usable|unusable|doesn.t work|does not work|broken|defect"
    )
    medium = haystack.rlike(
        "bad|worst|disappoint|waste|hate|awful|terrible|poor|irritat|leak|greasy|sticky|"
        "didn.t like|did not like"
    )
    low = haystack.rlike("wish|could be better|a little|slightly|minor|small issue")
    return (
        F.when(high, F.lit("high"))
        .when(medium, F.lit("medium"))
        .when(low, F.lit("low"))
        .otherwise(F.lit("none"))
    )


def review_text_aspects_expression(haystack):
    aspects = F.concat_ws(
        ",",
        F.when(haystack.rlike("work|effect|result|moisturi[sz]|hydrate|cleanse|soft|smooth|glow"), F.lit("effectiveness")),
        F.when(haystack.rlike("scent|smell|fragrance|perfume|odor"), F.lit("scent")),
        F.when(haystack.rlike("texture|sticky|greasy|oily|thick|thin|absorb"), F.lit("texture")),
        F.when(haystack.rlike("package|packaging|bottle|pump|cap|leak"), F.lit("packaging")),
        F.when(haystack.rlike("rash|breakout|acne|irritat|burn|allerg|redness|sensitive"), F.lit("skin_reaction")),
        F.when(haystack.rlike("price|cost|value|expensive|cheap"), F.lit("price")),
        F.when(haystack.rlike("shipping|deliver|arriv|late|box"), F.lit("delivery")),
    )
    return F.when(F.length(aspects) > 0, aspects).otherwise(F.lit("other"))


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
    raw_target = first_matching_column(frame, target)
    if raw_target:
        return safe_col(frame, raw_target)
    normalized_source = normalize_column_name(source_field)
    if target == normalized_source:
        return safe_col(frame, source_field)
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
    return field_expressions.get(field_key, F.lit(""))


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


def evaluate_review_row_analysis_checks(frame, steps):
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
    total_rows = frame.count()
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
        resolved_output = resolve_column_name(frame, step_output or target)
        check = {
            "allowedValues": allowed_values if method == "one_of_values" else [],
            "id": str(step.get("id") or target or step_output),
            "method": method,
            "output": step_output or target,
            "rawMethod": raw_method,
            "runtimeStatus": "recorded",
            "supportedMethods": sorted(REVIEW_ROW_ANALYSIS_SUPPORTED_METHODS),
            "target": target,
            "totalRows": total_rows,
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
        check.update({
            "expectedValues": expected_values,
            "invalidRows": invalid_rows,
            "runtimeStatus": "valid_output" if invalid_rows == 0 else "needs_review",
            "validRows": valid_rows,
            "validationStatus": "structural_check_only",
        })
        checks.append(check)
    return checks


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


def evaluate_custom_csv_classifier_checks(frame, steps):
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
    total_rows = frame.count()
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


def evaluate_quality_rules(frame, rules):
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

    total_rows = frame.count()
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


def quote_identifier(name):
    return f"`{str(name).replace('`', '``')}`"


def normalize_columns(frame):
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
    return frame.select(*expressions)


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
    value = json.loads(raw)
    return value if isinstance(value, list) else fallback


def load_json_file(path, fallback):
    if not path:
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return fallback
    return value if isinstance(value, dict) else fallback


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
