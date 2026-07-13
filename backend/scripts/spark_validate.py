import json
import os
import sys

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql import types as T


def main():
    endpoint = os.environ.get("MINIO_ENDPOINT", "http://m3-minio:9000")
    access_key = os.environ.get("MINIO_ACCESS_KEY", "m3admin")
    secret_key = os.environ.get("MINIO_SECRET_KEY", "wishuponastar")
    bucket = os.environ.get("ASKLAKE_SAMPLE_BUCKET", "m3-raw")
    prefix = os.environ.get("ASKLAKE_SAMPLE_PREFIX", "asklake-test-samples").strip("/")
    full_count = os.environ.get("ASKLAKE_SPARK_FULL_COUNT", "false").lower() == "true"

    spark = (
        SparkSession.builder.appName("asklake-source-schema-spark-validation")
        .config("spark.sql.caseSensitive", "true")
        .config("spark.hadoop.fs.s3a.endpoint", endpoint)
        .config("spark.hadoop.fs.s3a.access.key", access_key)
        .config("spark.hadoop.fs.s3a.secret.key", secret_key)
        .config("spark.hadoop.fs.s3a.path.style.access", "true")
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")

    results = []
    try:
        results.append(validate_csv(spark, bucket, prefix, full_count))
        results.append(validate_jsonl(spark, bucket, prefix, full_count))
        results.append(validate_json(spark, bucket, prefix, full_count))
        results.append(validate_text(spark, bucket, prefix, full_count))
        results.append(validate_parquet(spark, bucket, prefix, full_count))
        results.append(validate_transform_types(spark))
    finally:
        spark.stop()

    print(json.dumps({"results": results}, ensure_ascii=False, indent=2))


def bounded_count(df, full_count):
    return df.count() if full_count else df.limit(10000).count()


def validate_csv(spark, bucket, prefix, full_count):
    path = data_path("ASKLAKE_CSV_PATH", bucket, prefix, "csv/*.csv")
    df = (
        spark.read.option("header", "true")
        .option("inferSchema", "true")
        .option("samplingRatio", os.environ.get("ASKLAKE_CSV_SAMPLING_RATIO", "0.02"))
        .csv(path)
    )
    assert len(df.columns) > 0, "CSV schema should not be empty"
    transformed = (
        df.withColumn("event_ts_cast", F.to_timestamp("event_time"))
        .withColumn("product_id_long", F.col("product_id").cast("long"))
        .withColumn("price_double", F.col("price").cast("double"))
        .withColumn("brand_trimmed", F.trim(F.col("brand")))
    )
    count = bounded_count(transformed, full_count)
    assert count > 0, "CSV sample should have rows"
    return {"columns": transformed.columns, "format": "csv", "rowsChecked": count, "status": "ok"}


def validate_jsonl(spark, bucket, prefix, full_count):
    path = data_path("ASKLAKE_JSONL_PATH", bucket, prefix, "jsonl/*.jsonl")
    df = spark.read.json(path)
    assert len(df.columns) > 0, "JSONL schema should not be empty"
    count = bounded_count(df, full_count)
    assert count > 0, "JSONL sample should have rows"
    return {"columns": df.columns[:20], "format": "jsonl", "rowsChecked": count, "status": "ok"}


def validate_json(spark, bucket, prefix, full_count):
    path = data_path("ASKLAKE_JSON_PATH", bucket, prefix, "json/*.json")
    df = spark.read.option("multiLine", "true").json(path)
    assert len(df.columns) > 0, "JSON schema should not be empty"
    assert df.columns != ["_corrupt_record"], "JSON sample should parse into real columns, not only _corrupt_record"
    count = bounded_count(df, full_count)
    assert count > 0, "JSON sample should have rows"
    return {"columns": df.columns[:20], "format": "json", "rowsChecked": count, "status": "ok"}


def validate_text(spark, bucket, prefix, full_count):
    path = data_path("ASKLAKE_TXT_PATH", bucket, prefix, "txt/*.txt")
    df = spark.read.text(path)
    count = bounded_count(df, full_count)
    assert count > 0, "TXT sample should have rows"
    return {"columns": df.columns, "format": "txt", "rowsChecked": count, "status": "ok"}


def validate_parquet(spark, bucket, prefix, full_count):
    path = data_path("ASKLAKE_PARQUET_PATH", bucket, prefix, "parquet/*.parquet")
    df = spark.read.parquet(path)
    assert len(df.columns) > 0, "Parquet schema should not be empty"
    count = bounded_count(df, full_count)
    assert count > 0, "Parquet sample should have rows"
    return {"columns": df.columns[:20], "format": "parquet", "rowsChecked": count, "status": "ok"}


def data_path(env_name, bucket, prefix, suffix):
    override = os.environ.get(env_name)
    if override:
        return override
    return f"s3a://{bucket}/{prefix}/{suffix}"


def validate_transform_types(spark):
    schema = T.StructType(
        [
            T.StructField("string_value", T.StringType(), False),
            T.StructField("int_value", T.StringType(), False),
            T.StructField("long_value", T.StringType(), False),
            T.StructField("double_value", T.StringType(), False),
            T.StructField("bool_value", T.StringType(), False),
            T.StructField("timestamp_value", T.StringType(), False),
            T.StructField("json_value", T.StringType(), False),
        ]
    )
    df = spark.createDataFrame(
        [("  asklake  ", "42", "900719925", "12.75", "true", "2026-07-04T00:00:00Z", '{"nested":{"k":"v"}}')],
        schema,
    )
    transformed = (
        df.select(
            F.trim("string_value").alias("string_trim"),
            F.col("int_value").cast("int").alias("int_cast"),
            F.col("long_value").cast("long").alias("long_cast"),
            F.col("double_value").cast("double").alias("double_cast"),
            F.col("bool_value").cast("boolean").alias("bool_cast"),
            F.to_timestamp("timestamp_value").alias("timestamp_cast"),
            F.get_json_object("json_value", "$.nested.k").alias("json_path"),
        )
    )
    row = transformed.collect()[0].asDict()
    assert row["string_trim"] == "asklake"
    assert row["int_cast"] == 42
    assert row["long_cast"] == 900719925
    assert abs(row["double_cast"] - 12.75) < 0.001
    assert row["bool_cast"] is True
    assert row["timestamp_cast"] is not None
    assert row["json_path"] == "v"
    return {"columns": list(row.keys()), "format": "transform_type_fixture", "rowsChecked": 1, "status": "ok"}


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"spark validation failed: {exc}", file=sys.stderr)
        raise
