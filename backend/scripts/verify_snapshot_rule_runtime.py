import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal

from pyspark.sql import SparkSession

from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules
from spark_snapshot_rules import apply_spark_snapshot_rules


def main():
    fixture_path = sys.argv[1]
    with open(fixture_path, encoding="utf-8") as handle:
        fixture = json.load(handle)

    spark = (
        SparkSession.builder
        .appName("asklake-snapshot-rule-conformance")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.ui.enabled", "false")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")
    try:
        verify_transform_only_action_budget(spark)
        for case in fixture["cases"]:
            verify_case(spark, case)
    finally:
        spark.stop()
    print("verify-snapshot-rule-runtime-spark: ok")


def verify_transform_only_action_budget(spark):
    frame = spark.createDataFrame([("1",), ("invalid",)], schema="value string")
    rule = {
        "contractVersion": "1.0",
        "enabled": True,
        "failureDisposition": "keep",
        "id": "transform-only-cast",
        "inputColumns": ["value"],
        "kind": "transform",
        "onError": "warn",
        "operation": "cast",
        "outputColumns": ["value_long"],
        "outputType": "Long",
        "parameters": {"targetType": "Long"},
    }
    dataframe_type = type(frame)
    original_count = dataframe_type.count
    count_calls = 0

    def tracked_count(current):
        nonlocal count_calls
        count_calls += 1
        return original_count(current)

    dataframe_type.count = tracked_count
    try:
        result = apply_spark_snapshot_rules(spark, frame, [rule], input_row_count=2)
    finally:
        dataframe_type.count = original_count

    assert count_calls == 1, f"transform-only runtime must use one invalid-count action, got {count_calls}"
    assert result["quality"]["configuredRuleCount"] == 0, result["quality"]
    assert result["quality"]["evaluatedRowCount"] == 2, result["quality"]
    assert result["transform"]["errorCount"] == 1, result["transform"]


def verify_case(spark, case):
    records = case.get("records") or []
    frame = spark.read.json(spark.sparkContext.parallelize([json.dumps(record) for record in records]))
    expected = case["expected"]
    try:
        result = apply_snapshot_rules(frame, case.get("rules") or [])
    except SnapshotRuleExecutionError as error:
        assert expected["status"] == "failed", case["name"]
        assert error.failed_stage == expected["failedStage"], case["name"]
        assert error.rule_id == expected["ruleId"], case["name"]
        return

    assert expected["status"] == "success", case["name"]
    actual_records = [row.asDict(recursive=True) for row in result["frame"].collect()]
    assert_projected_records(actual_records, expected.get("records") or [], case["name"])

    quarantine = []
    if result["quarantine"] is not None:
        quarantine = [row.asDict(recursive=True) for row in result["quarantine"].collect()]
    assert_projected_records(quarantine, expected.get("quarantine") or [], f"{case['name']} quarantine")
    assert_partial(result["transform"], expected.get("transform") or {}, f"{case['name']} transform")
    assert_partial(result["quality"], expected.get("quality") or {}, f"{case['name']} quality")


def assert_projected_records(actual, expected, label):
    projected = []
    for expected_record in expected:
        event_id = expected_record.get("event_id")
        match = next((record for record in actual if str(record.get("event_id") or "") == str(event_id or "")), None)
        assert match is not None, f"{label}: missing event_id {event_id} in {actual}"
        projected.append({key: normalize_value(match.get(key)) for key in expected_record})
    normalized_expected = [{key: normalize_value(value) for key, value in record.items()} for record in expected]
    assert projected == normalized_expected, f"{label}: expected {normalized_expected}, got {projected}"
    assert len(actual) == len(expected), f"{label}: expected {len(expected)} rows, got {len(actual)}"


def assert_partial(actual, expected, label):
    projected = {key: normalize_value(actual.get(key)) for key in expected}
    normalized_expected = {key: normalize_value(value) for key, value in expected.items()}
    assert projected == normalized_expected, f"{label}: expected {normalized_expected}, got {projected}"


def normalize_value(value):
    if isinstance(value, datetime):
        normalized = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return normalized.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: normalize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    return value


if __name__ == "__main__":
    main()
