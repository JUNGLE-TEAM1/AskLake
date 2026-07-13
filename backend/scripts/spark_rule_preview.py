import json
import os
import sys
from datetime import date, datetime

from pyspark.sql import SparkSession

from spark_job_run import (
    apply_schema_contract,
    merge_rule_output_schema,
    normalize_columns,
    select_final_schema_columns,
)
from spark_snapshot_rules import apply_spark_snapshot_rules, supports_spark_snapshot_rules


def main():
    payload_path = os.environ["ASKLAKE_RULE_PREVIEW_PAYLOAD_FILE"]
    report_path = os.environ["ASKLAKE_RULE_PREVIEW_REPORT_FILE"]
    spark = None
    try:
        with open(payload_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        records = payload.get("records") or []
        rules = payload.get("rules") or []
        if not records:
            raise ValueError("Preview requires at least one sample record.")
        if not supports_spark_snapshot_rules(rules):
            raise ValueError("Spark Preview received an unsupported canonical Rule operation.")

        spark = SparkSession.builder.appName("asklake-rule-preview").getOrCreate()
        spark.sparkContext.setLogLevel("WARN")
        source = spark.read.json(spark.sparkContext.parallelize([
            json.dumps(record, ensure_ascii=False)
            for record in records[:100]
        ]))
        normalized = normalize_columns(source)
        contracted = apply_schema_contract(
            normalized,
            payload.get("schemaColumns") or [],
            payload.get("transformSteps") or [],
        )
        execution = apply_spark_snapshot_rules(spark, contracted, rules)
        final_schema = merge_rule_output_schema(
            payload.get("schemaColumns") or [],
            payload.get("outputSchema") or [],
        )
        output = select_final_schema_columns(execution["frame"], final_schema)
        result = {
            "quality": execution["quality"],
            "quarantined": [row.asDict(recursive=True) for row in execution["quarantine"].limit(100).collect()]
            if execution["quarantine"] is not None
            else [],
            "records": [row.asDict(recursive=True) for row in output.limit(100).collect()],
            "status": "success",
            "transform": execution["transform"],
        }
    except Exception as exc:
        result = {
            "code": "RULE_PREVIEW_FAILED",
            "message": str(exc),
            "status": "failed",
        }
    finally:
        if spark is not None:
            spark.stop()

    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, default=json_default)
    if result["status"] != "success":
        print(result["message"], file=sys.stderr)
        return 1
    return 0


def json_default(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main())
