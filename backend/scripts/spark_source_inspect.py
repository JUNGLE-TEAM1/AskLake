import json
import os
import sys

from pyspark.sql import SparkSession
from object_storage_runtime import configure_spark_builder


def main():
    source_path = required_env("ASKLAKE_SOURCE_PATH")
    source_format = required_env("ASKLAKE_SOURCE_FORMAT").lower()
    row_limit = int(os.environ.get("ASKLAKE_SOURCE_ROW_LIMIT", "10") or "10")
    spark = make_spark()
    try:
        frame = read_source(spark, source_format, source_path)
        sample = frame.limit(max(1, min(row_limit, 50000)))
        rows = [
            [stringify(row[field.name]) for field in sample.schema.fields]
            for row in sample.collect()
        ]
        result = {
            "columns": [
                {
                    "name": field.name,
                    "nullable": field.nullable,
                    "type": field.dataType.simpleString(),
                }
                for field in sample.schema.fields
            ],
            "rows": rows,
        }
        print(f"ASKLAKE_SOURCE_INSPECT={json.dumps(result, ensure_ascii=False, sort_keys=True)}")
        return 0
    except Exception as exc:
        print(f"Spark source inspect failed: {exc}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


def make_spark():
    spark = configure_spark_builder(
        SparkSession.builder.appName("asklake-source-inspect")
    ).getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark


def read_source(spark, source_format, source_path):
    if source_format == "parquet":
        return spark.read.parquet(source_path)
    if source_format == "csv":
        return spark.read.option("header", "true").option("inferSchema", "true").csv(source_path)
    if source_format == "jsonl":
        return spark.read.option("multiLine", "false").json(source_path)
    if source_format == "json":
        return spark.read.option("multiLine", "true").json(source_path)
    if source_format in {"txt", "text"}:
        return spark.read.text(source_path)
    raise ValueError(f"Unsupported source format: {source_format}")


def stringify(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def required_env(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required")
    return value


if __name__ == "__main__":
    sys.exit(main())
