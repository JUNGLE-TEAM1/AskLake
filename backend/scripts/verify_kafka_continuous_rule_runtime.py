import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


RULES = [
    {
        "contractVersion": "1.0",
        "enabled": True,
        "failureDisposition": "keep",
        "id": "normalize-review",
        "inputColumns": ["review"],
        "kind": "transform",
        "onError": "warn",
        "operation": "lowercase_trim",
        "outputColumns": ["review_clean"],
        "outputType": "String",
        "parameters": {},
    },
    {
        "contractVersion": "1.0",
        "enabled": True,
        "failureDisposition": "keep",
        "id": "cast-rating",
        "inputColumns": ["rating"],
        "kind": "transform",
        "onError": "quarantine",
        "operation": "cast",
        "outputColumns": ["rating"],
        "outputType": "Double",
        "parameters": {"targetType": "Double"},
    },
    {
        "contractVersion": "1.0",
        "enabled": True,
        "failureDisposition": "keep",
        "id": "accepted-review",
        "inputColumns": ["review_clean"],
        "kind": "quality",
        "onError": "warn",
        "operation": "accepted_values",
        "outputColumns": [],
        "parameters": {"values": ["good"]},
        "severity": "warning",
    },
]
OUTPUT_SCHEMA = [["event_id", "String"], ["review", "String"], ["rating", "Double"], ["review_clean", "String"]]


def fingerprint(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def configure_environment(root):
    rule_fingerprint = fingerprint({"contractVersion": "1.0", "rules": RULES})
    schema_columns = [
        {"included": True, "nullable": False, "sourceName": "event_id", "sourceType": "String", "targetName": "event_id", "type": "String"},
        {"included": True, "nullable": True, "sourceName": "review", "sourceType": "String", "targetName": "review", "type": "String"},
        {"included": True, "nullable": True, "sourceName": "rating", "sourceType": "String", "targetName": "rating", "type": "Double"},
    ]
    os.environ.update({
        "ASKLAKE_CONTINUOUS_JOB_ID": "continuous-rule-runtime",
        "ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID": "verify-attempt",
        "ASKLAKE_CONTINUOUS_REPORT_FILE": f"{root}/report.json",
        "ASKLAKE_CONTINUOUS_COMMAND_FILE": f"{root}/command.json",
        "ASKLAKE_CONTINUOUS_BROKER": "unused:9092",
        "ASKLAKE_CONTINUOUS_TOPIC": "reviews.verify",
        "ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID": "asklake-verify-rules",
        "ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION": "1.0",
        "ASKLAKE_CONTINUOUS_RULE_FINGERPRINT": rule_fingerprint,
        "ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA": json.dumps(OUTPUT_SCHEMA),
        "ASKLAKE_CONTINUOUS_RULES": json.dumps(RULES),
        "ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS": json.dumps(schema_columns),
        "ASKLAKE_MAINTENANCE_RULE_CONTRACT_VERSION": "1.0",
        "ASKLAKE_MAINTENANCE_RULE_FINGERPRINT": rule_fingerprint,
        "ASKLAKE_MAINTENANCE_RULE_OUTPUT_SCHEMA": json.dumps(OUTPUT_SCHEMA),
        "ASKLAKE_MAINTENANCE_RULES": json.dumps(RULES),
        "ASKLAKE_MAINTENANCE_JOB_ID": "continuous-rule-runtime",
        "ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS": json.dumps(schema_columns),
        "ASKLAKE_MAINTENANCE_SCHEMA_FINGERPRINT": "schema-rule-runtime-v1",
        "ASKLAKE_MAINTENANCE_SCHEMA_POLICY": json.dumps({"unknownField": "preserve"}),
        "ASKLAKE_MAINTENANCE_OFFSETS": "[]",
        "ASKLAKE_MAINTENANCE_APPROVE_UNKNOWN_FIELDS": "false",
    })


def main():
    with tempfile.TemporaryDirectory() as root:
        configure_environment(root)
        import kafka_continuous_stream as worker
        import kafka_continuous_maintenance as maintenance
        from snapshot_rule_runtime import SnapshotRuleExecutionError, apply_snapshot_rules
        from pyspark.sql import SparkSession, types as T

        spark = (
            SparkSession.builder
            .appName("asklake-continuous-rule-runtime-verifier")
            .config("spark.sql.session.timeZone", "UTC")
            .config("spark.ui.enabled", "false")
            .getOrCreate()
        )
        spark.sparkContext.setLogLevel("ERROR")
        try:
            worker.METRICS["ruleMetrics"] = {"qualityWarnCount": 999}
            worker.METRICS["lastRuleResult"] = {"status": "stale"}
            worker.report("starting")
            report = json.loads((Path(root) / "report.json").read_text(encoding="utf-8"))
            assert report["ruleMetrics"]["qualityWarnCount"] == 0
            assert report["lastRuleResult"] == {}
            assert report["lastBatchEvidence"] == {}
            worker.METRICS.pop("ruleMetrics", None)
            worker.METRICS.pop("lastRuleResult", None)

            configured_rules = worker.RULES
            worker.RULES = []
            pass_through_steps = worker.build_batch_dag_steps(
                status="success",
                consumed_count=3,
                schema_accepted_count=3,
                schema_quarantined_count=0,
                stored_count=3,
                quarantined_count=0,
                source_ranges=[{"topic": "reviews.verify", "partition": 0, "startOffset": 0, "endOffset": 3}],
            )
            worker.RULES = configured_rules
            assert [step["id"] for step in pass_through_steps] == [
                "source", "schema", "transform", "quality", "target", "manifest-checkpoint", "catalog",
            ]
            assert pass_through_steps[2]["meta"] == "pass-through"
            assert pass_through_steps[3]["meta"] == "pass-through"
            assert pass_through_steps[-1]["status"] == "pending"

            worker.source_schema()
            schema = T.StructType([
                T.StructField("event_id", T.StringType(), True),
                T.StructField("review", T.StringType(), True),
                T.StructField("rating", T.StringType(), True),
                T.StructField("topic", T.StringType(), True),
                T.StructField("kafka_partition", T.LongType(), True),
                T.StructField("kafka_offset", T.LongType(), True),
                T.StructField("kafka_timestamp", T.TimestampType(), True),
                T.StructField("raw_payload", T.StringType(), True),
                T.StructField("ingested_at", T.TimestampType(), True),
            ])
            observed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            frame = spark.createDataFrame([
                ("event-1", " GOOD ", "5", "reviews.verify", 0, 10, observed_at, '{"event_id":"event-1","review":" GOOD ","rating":"5"}', observed_at),
                ("event-2", "GOOD", "invalid", "reviews.verify", 1, 20, observed_at, '{"event_id":"event-2","review":"GOOD","rating":"invalid"}', observed_at),
                ("event-3", " Bad ", "3", "reviews.verify", 0, 11, observed_at, '{"event_id":"event-3","review":" Bad ","rating":"3"}', observed_at),
            ], schema)

            result = apply_snapshot_rules(frame, RULES)
            assert result["timings"]["transformDurationMs"] >= 0
            assert result["timings"]["qualityDurationMs"] >= 0
            target = worker.select_continuous_target(result["frame"])
            assert isinstance(target.schema["kafka_partition"].dataType, T.IntegerType)
            assert isinstance(target.schema["kafka_offset"].dataType, T.LongType)
            rows = {row["event_id"]: row.asDict(recursive=True) for row in target.collect()}
            assert set(rows) == {"event-1", "event-3"}
            assert rows["event-1"]["review_clean"] == "good"
            assert rows["event-1"]["rating"] == 5.0
            assert result["transform"]["quarantinedCount"] == 1
            assert result["quality"]["warnCount"] == 1

            quarantine = worker.rule_quarantine_rows(result["quarantine"]).collect()
            assert len(quarantine) == 1
            assert quarantine[0]["partition"] == 1
            assert quarantine[0]["offset"] == 20
            assert quarantine[0]["rule_fingerprint"] == worker.RULE_FINGERPRINT

            mixed_quarantine_output = f"file://{root}/mixed-quarantine-output"
            worker.rule_quarantine_rows(result["quarantine"]).write.mode("overwrite").parquet(
                f"{mixed_quarantine_output}/_quarantine/_batches/batch_id=0"
            )
            schema_invalid = frame.limit(1).select(
                "topic",
                worker.col("kafka_partition").cast("int").alias("partition"),
                worker.col("kafka_offset").alias("offset"),
                "kafka_timestamp",
                "raw_payload",
            )
            worker.schema_quarantine_rows(
                schema_invalid,
                worker.lit(True),
                worker.lit(False),
                worker.lit(False),
                worker.lit(False),
            ).write.mode("overwrite").parquet(
                f"{mixed_quarantine_output}/_quarantine/_batches/batch_id=1"
            )
            mixed_quarantine = maintenance.read_quarantine(spark, mixed_quarantine_output)
            assert mixed_quarantine.count() == 2
            assert isinstance(mixed_quarantine.schema["partition"].dataType, T.IntegerType)

            maintenance_output = f"file://{root}/maintenance-output"
            worker.rule_quarantine_rows(result["quarantine"]).write.mode("overwrite").parquet(
                f"{maintenance_output}/_quarantine/_batches/batch_id=0"
            )
            iceberg_target = {
                "catalog": "iceberg",
                "namespace": "asklake",
                "partitionColumns": [],
                "table": "continuous_rule_runtime",
                "tableUri": "iceberg://iceberg/asklake/continuous_rule_runtime",
                "writeMode": "append",
            }
            maintenance.read_iceberg_target = lambda _spark, _target: None
            replay = maintenance.replay_quarantine(spark, maintenance_output, "verify", iceberg_target)
            assert replay["storedCount"] == 0
            assert replay["failedCount"] == 1
            assert replay["ruleRejectedCount"] == 1

            worker.update_rule_metrics(result["transform"], result["quality"])
            assert worker.RULE_METRICS["transformQuarantinedCount"] == 1
            assert worker.RULE_METRICS["qualityWarnCount"] == 1

            checkpoint = f"file://{root}/checkpoint"
            output = f"file://{root}/output"
            worker.ensure_checkpoint_contract(spark, checkpoint, output, iceberg_target)
            assert worker.RUNTIME_FINGERPRINT
            worker.ensure_checkpoint_contract(spark, checkpoint, output, iceberg_target)
            original_rule_fingerprint = worker.RULE_FINGERPRINT
            original_expected = worker.EXPECTED_RULE_FINGERPRINT
            worker.RULE_FINGERPRINT = "changed-rule-fingerprint"
            worker.EXPECTED_RULE_FINGERPRINT = ""
            try:
                worker.ensure_checkpoint_contract(spark, checkpoint, output, iceberg_target)
            except RuntimeError as error:
                assert "checkpoint contract fingerprint mismatch" in str(error)
            else:
                raise AssertionError("Changed Rule contract must not reuse an initialized checkpoint.")
            finally:
                worker.RULE_FINGERPRINT = original_rule_fingerprint
                worker.EXPECTED_RULE_FINGERPRINT = original_expected

            fail_rule = [{
                "contractVersion": "1.0",
                "enabled": True,
                "failureDisposition": "keep",
                "id": "event-required",
                "inputColumns": ["event_id"],
                "kind": "quality",
                "onError": "fail_batch",
                "operation": "not_null",
                "outputColumns": [],
                "parameters": {},
                "severity": "error",
            }]
            try:
                apply_snapshot_rules(frame.withColumn("event_id", worker.lit(None).cast("string")), fail_rule)
            except SnapshotRuleExecutionError as error:
                assert error.failed_stage == "quality"
                assert error.rule_id == "event-required"
                assert error.timings["qualityDurationMs"] >= 0
            else:
                raise AssertionError("fail_batch must fail the bounded micro-batch.")
        finally:
            spark.stop()
    print("verify-kafka-continuous-rule-runtime: ok")


if __name__ == "__main__":
    main()
