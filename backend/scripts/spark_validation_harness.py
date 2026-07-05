#!/usr/bin/env python3
"""Validate AskLake MinIO sample prefixes with Spark S3A."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pyspark.sql import SparkSession
from pyspark.sql.functions import col, to_date, to_timestamp


SUPPORTED_TYPES = ("csv", "jsonl", "json", "parquet", "txt")


@dataclass(frozen=True)
class HarnessConfig:
    endpoint: str
    region: str
    bucket: str
    sample_prefix: str
    access_key: str
    secret_key: str
    path_style: bool
    ssl_enabled: bool


def normalize_prefix(value: str | None) -> str:
    cleaned = (value or "").strip().strip("/")
    return f"{cleaned}/" if cleaned else ""


def normalize_endpoint(value: str) -> str:
    return value.strip().rstrip("/")


def getenv_first(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def required_env(*names: str) -> str:
    value = getenv_first(*names)
    if value:
        return value
    joined = " or ".join(names)
    raise ValueError(f"Missing required environment variable: {joined}")


def parse_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def load_config() -> HarnessConfig:
    endpoint = normalize_endpoint(
        os.environ.get("SPARK_MINIO_ENDPOINT")
        or os.environ.get("MINIO_ENDPOINT", "http://127.0.0.1:9000")
    )
    return HarnessConfig(
        endpoint=endpoint,
        region=os.environ.get("SPARK_MINIO_REGION")
        or os.environ.get("MINIO_REGION", "us-east-1"),
        bucket=os.environ.get("SPARK_MINIO_BUCKET")
        or os.environ.get("MINIO_BUCKET", "m3-raw"),
        sample_prefix=normalize_prefix(
            os.environ.get("SPARK_SAMPLE_PREFIX")
            or os.environ.get("MINIO_SAMPLE_PREFIX", "asklake_samples"),
        ),
        access_key=required_env(
            "SPARK_MINIO_ACCESS_KEY",
            "MINIO_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
        ),
        secret_key=required_env(
            "SPARK_MINIO_SECRET_KEY",
            "MINIO_SECRET_KEY",
            "AWS_SECRET_ACCESS_KEY",
        ),
        path_style=parse_bool(os.environ.get("SPARK_S3A_PATH_STYLE_ACCESS"), True),
        ssl_enabled=parse_bool(
            os.environ.get("SPARK_S3A_SSL_ENABLED"),
            endpoint.startswith("https://"),
        ),
    )


def configure_s3a(spark: SparkSession, config: HarnessConfig) -> None:
    hadoop_conf = spark.sparkContext._jsc.hadoopConfiguration()
    settings = {
        "fs.s3a.endpoint": config.endpoint,
        "fs.s3a.access.key": config.access_key,
        "fs.s3a.secret.key": config.secret_key,
        "fs.s3a.path.style.access": str(config.path_style).lower(),
        "fs.s3a.connection.ssl.enabled": str(config.ssl_enabled).lower(),
        "fs.s3a.aws.credentials.provider": (
            "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider"
        ),
        "fs.s3a.impl": "org.apache.hadoop.fs.s3a.S3AFileSystem",
    }
    if config.region:
        settings["fs.s3a.endpoint.region"] = config.region
    for key, value in settings.items():
        hadoop_conf.set(key, value)


def make_spark(args: argparse.Namespace, config: HarnessConfig) -> SparkSession:
    builder = SparkSession.builder.appName(args.app_name)
    if args.master:
        builder = builder.master(args.master)
    spark = builder.getOrCreate()
    configure_s3a(spark, config)
    return spark


def s3a_path(config: HarnessConfig, data_type: str) -> str:
    return f"s3a://{config.bucket}/{config.sample_prefix}{data_type}/"


def read_dataset(spark: SparkSession, data_type: str, path: str, args: argparse.Namespace):
    if data_type == "csv":
        return (
            spark.read.option("header", str(args.csv_header).lower())
            .option("inferSchema", "true")
            .csv(path)
        )
    if data_type == "jsonl":
        return spark.read.option("multiLine", "false").json(path)
    if data_type == "json":
        return spark.read.option("multiLine", "true").json(path)
    if data_type == "parquet":
        return spark.read.parquet(path)
    if data_type == "txt":
        return spark.read.text(path)
    raise ValueError(f"Unsupported type: {data_type}")


def validate_dataset(
    spark: SparkSession,
    config: HarnessConfig,
    data_type: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    path = s3a_path(config, data_type)
    print(f"\n=== {data_type.upper()} {path} ===")
    result: dict[str, Any] = {
        "type": data_type,
        "path": path,
        "status": "failed",
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        frame = read_dataset(spark, data_type, path, args)
        frame.printSchema()
        if args.show_sample:
            frame.show(args.sample_rows, truncate=False)
        if args.exact_count:
            count = frame.count()
            count_mode = "exact"
        else:
            count = frame.limit(args.limit).count()
            count_mode = f"limit_{args.limit}"
        result.update(
            {
                "status": "passed",
                "count_mode": count_mode,
                "count": int(count),
                "columns": frame.columns,
            }
        )
        print(f"{data_type} validation passed: {count_mode} count={count}")
    except Exception as exc:  # noqa: BLE001 - report every Spark read failure.
        result["error"] = str(exc)
        print(f"{data_type} validation failed: {exc}", file=sys.stderr)
    return result


def validate_cast_fixture(spark: SparkSession) -> dict[str, Any]:
    print("\n=== TRANSFORM CAST FIXTURE ===")
    result: dict[str, Any] = {
        "type": "transform_cast_fixture",
        "status": "failed",
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        rows = [
            ("1", "12.50", "true", "2026-07-04 12:34:56", "2026-07-04"),
            ("2", "0.00", "false", "2026-07-05 00:00:00", "2026-07-05"),
            ("3", "-7.25", "true", "2026-07-06 08:15:00", "2026-07-06"),
        ]
        frame = spark.createDataFrame(
            rows,
            [
                "id_text",
                "amount_text",
                "active_text",
                "event_ts_text",
                "event_date_text",
            ],
        )
        casted = frame.select(
            col("id_text").cast("int").alias("id_int"),
            col("amount_text").cast("double").alias("amount_double"),
            col("active_text").cast("boolean").alias("active_bool"),
            to_timestamp("event_ts_text").alias("event_ts"),
            to_date("event_date_text").alias("event_date"),
        )
        casted.printSchema()
        casted.show(truncate=False)
        null_counts = {
            field.name: casted.filter(col(field.name).isNull()).count()
            for field in casted.schema.fields
        }
        failed_columns = [name for name, count in null_counts.items() if count > 0]
        status = "passed" if not failed_columns else "failed"
        result.update({"status": status, "null_counts": null_counts})
        print(f"cast fixture {status}: null_counts={null_counts}")
    except Exception as exc:  # noqa: BLE001 - report Spark runtime failures.
        result["error"] = str(exc)
        print(f"cast fixture failed: {exc}", file=sys.stderr)
    return result


def parse_types(value: str) -> list[str]:
    requested = [item.strip().lower() for item in value.split(",") if item.strip()]
    if not requested:
        raise argparse.ArgumentTypeError("must include at least one type")
    unknown = [item for item in requested if item not in SUPPORTED_TYPES]
    if unknown:
        raise argparse.ArgumentTypeError(
            f"Unsupported type(s): {', '.join(unknown)}. "
            f"Supported: {', '.join(SUPPORTED_TYPES)}"
        )
    return requested


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate AskLake MinIO sample prefixes through Spark S3A.",
    )
    parser.add_argument(
        "--types",
        type=parse_types,
        default=list(SUPPORTED_TYPES),
        help="Comma-separated types to validate. Default: all.",
    )
    parser.add_argument("--app-name", default="asklake-minio-spark-validation")
    parser.add_argument("--master", help="Optional Spark master, e.g. local[*].")
    parser.add_argument("--limit", type=positive_int, default=1000)
    parser.add_argument("--exact-count", action="store_true")
    parser.add_argument("--csv-header", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--show-sample", action="store_true")
    parser.add_argument("--sample-rows", type=positive_int, default=5)
    parser.add_argument("--report-file", help="Optional local JSON report path.")
    return parser


def write_report(results: list[dict[str, Any]], path: str | None) -> None:
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        json.dump({"results": results}, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"report written: {output}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    spark: SparkSession | None = None
    results: list[dict[str, Any]] = []
    try:
        config = load_config()
        spark = make_spark(args, config)
        for data_type in args.types:
            results.append(validate_dataset(spark, config, data_type, args))
        results.append(validate_cast_fixture(spark))
        write_report(results, args.report_file)
        failed = [item for item in results if item.get("status") != "passed"]
        return 1 if failed else 0
    except ValueError as exc:
        print(f"spark harness configuration failed: {exc}", file=sys.stderr)
        return 2
    finally:
        if spark is not None:
            spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
