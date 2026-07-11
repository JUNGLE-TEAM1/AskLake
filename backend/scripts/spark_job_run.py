import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T


def main():
    started_at = now_iso()
    started_ms = int(time.time() * 1000)
    report_file = os.environ.get("ASKLAKE_SPARK_REPORT_FILE")
    source_path = os.environ.get("ASKLAKE_SPARK_SOURCE_PATH", "-")
    source_format = os.environ.get("ASKLAKE_SPARK_SOURCE_FORMAT", "unknown").lower()
    output_path = os.environ.get("ASKLAKE_SPARK_OUTPUT_PATH", "-")
    run_id = os.environ.get("ASKLAKE_SPARK_RUN_ID", "unknown")
    source_collection = {}
    source_parsing = {}
    spark = None
    try:
        source_path = required_env("ASKLAKE_SPARK_SOURCE_PATH")
        source_format = required_env("ASKLAKE_SPARK_SOURCE_FORMAT").lower()
        output_path = required_env("ASKLAKE_SPARK_OUTPUT_PATH")
        run_id = required_env("ASKLAKE_SPARK_RUN_ID")
        row_limit = int(os.environ.get("ASKLAKE_SPARK_RUN_ROW_LIMIT", "0") or "0")
        manifest = load_spark_job_manifest()
        partition_columns = parse_partition_columns(
            manifest.get("partitionColumns") or os.environ.get("ASKLAKE_SPARK_PARTITION_COLUMNS")
        )
        schema_columns = manifest.get("schemaColumns") or load_json_env("ASKLAKE_SPARK_SCHEMA_COLUMNS", [])
        source_collection = manifest.get("sourceCollection") or {}
        source_parsing = manifest.get("sourceParsing") or {}
        transform_steps = manifest.get("transformSteps") or load_json_env("ASKLAKE_SPARK_TRANSFORM_STEPS", [])
        quality_rules = manifest.get("qualityRules") or load_json_env("ASKLAKE_SPARK_QUALITY_RULES", [])
        spark = make_spark()
        source_df = read_source(spark, source_format, source_path, schema_columns, source_parsing, source_collection)
        input_rows = source_df.count() if row_limit <= 0 else source_df.limit(row_limit).count()
        working_df = source_df if row_limit <= 0 else source_df.limit(row_limit)
        normalized_df = normalize_columns(working_df)
        contracted_df = apply_schema_contract(normalized_df, schema_columns, transform_steps)
        transformed_df = apply_transform_steps(spark, contracted_df, transform_steps)
        output_frame = select_final_schema_columns(transformed_df, schema_columns)
        output_df = output_frame.withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
            "_asklake_ingested_at",
            F.current_timestamp(),
        )
        resolved_partition_columns = resolve_partition_columns(output_df, partition_columns)
        writer = output_df.write.mode("overwrite")
        if resolved_partition_columns:
            writer = writer.partitionBy(*resolved_partition_columns)
        writer.parquet(output_path)
        written_df = spark.read.parquet(output_path)
        output_rows = written_df.count()
        quality = evaluate_quality_rules(written_df, quality_rules, total_rows=output_rows)
        sample_rows = collect_sample_rows(written_df, 10)
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
                "sourceParsing": source_parsing,
                "startedAt": started_at,
                "status": "failed",
            }
            write_report(report_file, result)
            print(f"ASKLAKE_SPARK_JOB_RESULT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
            return 1
        ended_at = now_iso()
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "format": source_format,
            "inputRows": input_rows,
            "outputPath": output_path,
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
            "sourceParsing": source_parsing,
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
            "sourceCollection": source_collection,
            "sourceParsing": source_parsing,
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


def read_source(spark, source_format, source_path, schema_columns, source_parsing=None, source_collection=None):
    base_reader = apply_source_collection(spark.read, source_collection or {})
    if source_format == "csv":
        parsing = source_parsing or {}
        fields = parsing.get("fields") or []
        reader = base_reader
        if fields:
            reader = reader.schema(delimited_struct_type(fields))
        else:
            infer_schema = "false" if schema_columns else "true"
            reader = reader.option("inferSchema", infer_schema)
        reader = (
            reader
            .option("header", str(bool(parsing.get("header", True))).lower())
            .option("mode", "PERMISSIVE")
            .option("multiLine", "false")
            .option("encoding", str(parsing.get("encoding") or "UTF-8"))
            .option("sep", str(parsing.get("delimiter") or ","))
        )
        if parsing.get("quote") is not None:
            reader = reader.option("quote", str(parsing.get("quote") or ""))
        if parsing.get("escape") is not None:
            reader = reader.option("escape", str(parsing.get("escape") or ""))
        row_delimiter = parsing.get("rowDelimiter")
        if row_delimiter and row_delimiter != "\r\n":
            reader = reader.option("lineSep", str(row_delimiter))
        return reader.csv(source_path)
    if source_format == "jsonl":
        return base_reader.option("multiLine", "false").json(source_path)
    if source_format == "json":
        return base_reader.option("multiLine", "true").json(source_path)
    if source_format == "parquet":
        return base_reader.parquet(source_path)
    if source_format in {"txt", "text"}:
        return base_reader.text(source_path)
    raise ValueError(f"Unsupported Spark source format: {source_format}")


def apply_source_collection(reader, source_collection):
    if str(source_collection.get("scope") or "file").lower() != "folder":
        return reader
    file_pattern = str(source_collection.get("filePattern") or "").strip()
    if file_pattern:
        reader = reader.option("pathGlobFilter", file_pattern)
    if bool(source_collection.get("recursive")):
        reader = reader.option("recursiveFileLookup", "true")
    return reader


def delimited_struct_type(fields):
    seen = set()
    struct_fields = []
    for index, field in enumerate(fields):
        name = str(field.get("name") or f"column_{index + 1}").strip()
        normalized = normalize_column_name(name)
        if not normalized or normalized in seen:
            raise ValueError("Delimited field names must be non-empty and unique.")
        seen.add(normalized)
        struct_fields.append(T.StructField(name, spark_data_type(field.get("type")), bool(field.get("nullable", True))))
    return T.StructType(struct_fields)


def spark_data_type(logical_type):
    normalized = str(logical_type or "string").strip().lower()
    if normalized in {"integer", "int"}:
        return T.IntegerType()
    if normalized in {"long", "bigint"}:
        return T.LongType()
    if normalized in {"float"}:
        return T.FloatType()
    if normalized in {"double", "decimal", "number", "numeric"}:
        return T.DoubleType()
    if normalized in {"boolean", "bool"}:
        return T.BooleanType()
    if normalized in {"timestamp", "datetime"}:
        return T.TimestampType()
    if normalized == "date":
        return T.DateType()
    return T.StringType()


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
    if not schema_columns:
        return frame

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
    contracted = frame.select(*expressions)
    null_required = [
        target
        for target in required_targets
        if contracted.filter(F.col(quote_identifier(target)).isNull()).limit(1).count() > 0
    ]
    if null_required:
        raise ValueError(f"Approved schema required columns produced null values after casting: {', '.join(null_required)}")
    return contracted


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
            if "," in raw:
                names.extend(part.strip() for part in raw.split(",") if part.strip())
            elif raw and "=" not in raw:
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
    if normalized in {"integer", "int", "int32"}:
        return try_cast_type(column_name, "int")
    if normalized in {"long", "bigint", "int64"}:
        return try_cast_type(column_name, "bigint")
    if normalized in {"float", "float32"}:
        return try_cast_type(column_name, "float")
    if normalized in {"double", "float64", "decimal", "number", "numeric"}:
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
    if normalized in {"integer", "int", "int32"}:
        return "int"
    if normalized in {"long", "bigint", "int64"}:
        return "bigint"
    if normalized in {"float", "float32"}:
        return "float"
    if normalized in {"double", "float64", "decimal", "number", "numeric"}:
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
        elif "json" in operation:
            expression = F.get_json_object(source.cast("string"), params or "$.value")
        elif "regex" in operation:
            expression = F.regexp_extract(source.cast("string"), params or r"^/products/([^/]+)", 1)
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
    value = json.loads(raw.lstrip("\ufeff"))
    return value if isinstance(value, list) else fallback


def load_spark_job_manifest():
    path = os.environ.get("ASKLAKE_SPARK_JOB_MANIFEST_FILE")
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
