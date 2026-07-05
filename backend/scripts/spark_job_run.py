import json
import os
import sys
import time
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F


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
        spark = make_spark()
        source_df = read_source(spark, source_format, source_path)
        input_rows = source_df.count() if row_limit <= 0 else source_df.limit(row_limit).count()
        working_df = source_df if row_limit <= 0 else source_df.limit(row_limit)
        normalized_df = normalize_columns(working_df).withColumn("_asklake_run_id", F.lit(run_id)).withColumn(
            "_asklake_ingested_at",
            F.current_timestamp(),
        )
        normalized_df.write.mode("overwrite").parquet(output_path)
        output_rows = spark.read.parquet(output_path).count()
        ended_at = now_iso()
        result = {
            "durationMs": int(time.time() * 1000) - started_ms,
            "endedAt": ended_at,
            "format": source_format,
            "inputRows": input_rows,
            "outputPath": output_path,
            "outputRows": output_rows,
            "runId": run_id,
            "schema": [
                {
                    "name": field.name,
                    "nullable": field.nullable,
                    "type": field.dataType.simpleString(),
                }
                for field in normalized_df.schema.fields
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
    spark.sparkContext.setLogLevel("WARN")
    return spark


def read_source(spark, source_format, source_path):
    if source_format == "csv":
        return spark.read.option("header", "true").option("inferSchema", "true").csv(source_path)
    if source_format == "jsonl":
        return spark.read.option("multiLine", "false").json(source_path)
    if source_format == "json":
        return spark.read.option("multiLine", "true").json(source_path)
    if source_format == "parquet":
        return spark.read.parquet(source_path)
    if source_format in {"txt", "text"}:
        return spark.read.text(source_path)
    raise ValueError(f"Unsupported Spark source format: {source_format}")


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


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


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
