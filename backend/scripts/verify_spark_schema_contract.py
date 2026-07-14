import sys

from pyspark.sql import SparkSession
from pyspark.sql import types as T

from spark_job_run import apply_schema_contract, normalize_columns, read_source


def main():
    fixture_path = sys.argv[1]
    spark = (
        SparkSession.builder
        .appName("asklake-spark-schema-contract")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.ui.enabled", "false")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")
    try:
        verify_required_column_job_count_does_not_scale(spark)
        verify_json_contract_avoids_inference_and_flattens_nested_fields(spark, fixture_path)
        verify_all_null_required_columns_are_reported(spark)
        verify_cast_failures_are_reported_as_required_nulls(spark)
        verify_nullable_and_missing_column_contracts(spark)
    finally:
        spark.stop()
    print("verify-spark-schema-contract: ok")


def verify_json_contract_avoids_inference_and_flattens_nested_fields(spark, fixture_path):
    schema_columns = [
        schema_column("event_id", nullable=False),
        schema_column("properties.position", nullable=False, logical_type="Integer"),
    ]
    transform_steps = [{"enabled": True, "input": "properties.position", "output": "properties_position"}]
    job_group = "json-read-with-approved-schema"

    spark.sparkContext.setJobGroup(job_group, "approved JSON schema must avoid inference action")
    source = read_source(
        spark,
        "jsonl",
        fixture_path,
        schema_columns,
        {},
        transform_steps,
    )
    job_ids = spark.sparkContext.statusTracker().getJobIdsForGroup(job_group)
    spark.sparkContext.setLocalProperty("spark.jobGroup.id", None)

    assert len(job_ids) == 0, f"JSON reader should not launch schema inference jobs: {job_ids}"
    direct_positions = [
        row["position"]
        for row in source.select(source["properties"].getField("position").alias("position"))
        .orderBy("position")
        .collect()
    ]
    assert direct_positions == ["1", "2"], direct_positions
    normalized = normalize_columns(source, schema_columns, transform_steps)
    assert "properties_position" in normalized.columns, normalized.columns
    rows = normalized.orderBy("event_id").collect()
    assert [row["properties_position"] for row in rows] == ["1", "2"], rows

    contracted = apply_schema_contract(normalized, schema_columns, transform_steps)
    positions = [row["properties_position"] for row in contracted.orderBy("event_id").collect()]
    assert positions == [1, 2], positions


def verify_required_column_job_count_does_not_scale(spark):
    one_column_jobs = required_validation_job_count(spark, 1)
    ten_column_jobs = required_validation_job_count(spark, 10)

    assert one_column_jobs > 0, "required column validation should execute Spark work"
    assert ten_column_jobs == one_column_jobs, (
        "required column validation jobs must not grow with the column count: "
        f"one column={one_column_jobs}, ten columns={ten_column_jobs}"
    )


def required_validation_job_count(spark, column_count):
    column_names = [f"column_{index}" for index in range(column_count)]
    schema = T.StructType([T.StructField(name, T.StringType(), True) for name in column_names])
    frame = spark.createDataFrame(
        [tuple(f"value-{row}-{index}" for index in range(column_count)) for row in range(3)],
        schema=schema,
    )
    contract = [schema_column(name, nullable=False) for name in column_names]
    job_group = f"required-null-{column_count}-columns"

    spark.sparkContext.setJobGroup(job_group, "required null validation should use one aggregate action")
    contracted = apply_schema_contract(frame, contract)
    job_ids = spark.sparkContext.statusTracker().getJobIdsForGroup(job_group)
    spark.sparkContext.setLocalProperty("spark.jobGroup.id", None)

    assert contracted.columns == column_names, contracted.columns
    return len(job_ids)


def verify_all_null_required_columns_are_reported(spark):
    column_names = ["event_id", "user_id", "product_id"]
    schema = T.StructType([T.StructField(name, T.StringType(), True) for name in column_names])
    frame = spark.createDataFrame(
        [("event-1", None, None), ("event-2", "user-2", "product-2")],
        schema=schema,
    )
    contract = [schema_column(name, nullable=False) for name in column_names]

    try:
        apply_schema_contract(frame, contract)
    except ValueError as error:
        message = str(error)
        assert "user_id" in message, message
        assert "product_id" in message, message
        assert "event_id" not in message, message
    else:
        raise AssertionError("required null columns should fail the schema contract")


def verify_cast_failures_are_reported_as_required_nulls(spark):
    schema = T.StructType([T.StructField("position", T.StringType(), True)])
    frame = spark.createDataFrame([("not-an-integer",), ("2",)], schema=schema)
    contract = [schema_column("position", nullable=False, logical_type="Integer")]

    try:
        apply_schema_contract(frame, contract)
    except ValueError as error:
        assert "position" in str(error), str(error)
    else:
        raise AssertionError("a failed required cast should fail the schema contract")


def verify_nullable_and_missing_column_contracts(spark):
    schema = T.StructType([T.StructField("optional_value", T.StringType(), True)])
    frame = spark.createDataFrame([(None,), ("present",)], schema=schema)
    nullable = apply_schema_contract(frame, [schema_column("optional_value", nullable=True)])
    assert nullable.count() == 2

    try:
        apply_schema_contract(frame, [schema_column("missing_required", nullable=False)])
    except ValueError as error:
        assert "missing_required" in str(error), str(error)
    else:
        raise AssertionError("a missing required source column should fail before target write")


def schema_column(name, *, nullable, logical_type="String"):
    return {
        "included": True,
        "nullable": nullable,
        "sourceName": name,
        "targetName": name,
        "type": logical_type,
    }


if __name__ == "__main__":
    main()
