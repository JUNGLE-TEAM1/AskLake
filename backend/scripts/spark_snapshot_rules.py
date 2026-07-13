import re
import time

from pyspark.sql import functions as F

from snapshot_rule_runtime import (
    QUALITY_OPERATIONS,
    TRANSFORM_OPERATIONS,
    SnapshotRuleExecutionError,
    apply_snapshot_rules,
)


SPARK_TRANSFORM_OPERATIONS = TRANSFORM_OPERATIONS | {"sql_expression"}


def supports_spark_snapshot_rules(rules):
    for rule in rules or []:
        if not rule or rule.get("enabled") is False:
            continue
        kind = str(rule.get("kind") or "")
        operation = str(rule.get("operation") or "")
        if kind == "transform" and operation in SPARK_TRANSFORM_OPERATIONS:
            continue
        if kind == "quality" and operation in QUALITY_OPERATIONS:
            continue
        return False
    return True


def apply_spark_snapshot_rules(spark, frame, rules):
    enabled = [rule for rule in (rules or []) if rule and rule.get("enabled") is not False]
    transforms = [rule for rule in enabled if rule.get("kind") == "transform"]
    quality_rules = [rule for rule in enabled if rule.get("kind") == "quality"]
    transform = _empty_transform(len(transforms))
    quarantine = None
    current = frame
    segment = []
    transform_started_at = time.monotonic()

    def flush_segment():
        nonlocal current, quarantine
        if not segment:
            return
        try:
            execution = apply_snapshot_rules(current, list(segment))
        except SnapshotRuleExecutionError as exc:
            _merge_transform(transform, exc.transform or {})
            exc.transform = transform
            raise
        current = execution["frame"]
        _merge_transform(transform, execution["transform"])
        quarantine = _merge_quarantine(quarantine, execution["quarantine"])
        segment.clear()

    for rule in transforms:
        if rule.get("operation") != "sql_expression":
            segment.append(rule)
            continue
        flush_segment()
        current, sql_quarantine = _apply_sql_rule(spark, current, rule, transform)
        quarantine = _merge_quarantine(quarantine, sql_quarantine)
    flush_segment()

    transform_duration_ms = _elapsed_ms(transform_started_at)
    try:
        quality_execution = apply_snapshot_rules(current, quality_rules)
    except SnapshotRuleExecutionError as exc:
        exc.transform = transform
        timings = dict(exc.timings or {})
        timings["transformDurationMs"] = transform_duration_ms
        exc.timings = timings
        raise
    quarantine = _merge_quarantine(quarantine, quality_execution["quarantine"])
    return {
        "frame": quality_execution["frame"],
        "quality": quality_execution["quality"],
        "quarantine": quarantine,
        "timings": {
            "transformDurationMs": transform_duration_ms,
            "qualityDurationMs": quality_execution.get("timings", {}).get("qualityDurationMs", 0),
        },
        "transform": transform,
    }


def _apply_sql_rule(spark, frame, rule, transform):
    expression = str((rule.get("parameters") or {}).get("expression") or "").strip()
    output = _normalize_name(_first(rule.get("outputColumns")) or _first(rule.get("inputColumns")))
    input_name = _resolve_column_name(frame, _first(rule.get("inputColumns")))
    row_count = frame.count()
    try:
        if expression.lower().startswith("select"):
            view_name = f"asklake_rule_input_{re.sub(r'[^0-9A-Za-z_]+', '_', str(rule.get('id') or 'sql'))}"
            frame.createOrReplaceTempView(view_name)
            try:
                rewritten = re.sub(r"\bfrom\s+input\b", f"FROM `{view_name}`", expression, flags=re.IGNORECASE)
                result = spark.sql(rewritten)
            finally:
                spark.catalog.dropTempView(view_name)
        else:
            result = frame.withColumn(output, F.expr(expression))
        result.count()
        transform["appliedStepCount"] += row_count
        return result, None
    except Exception as exc:
        transform["errorCount"] += row_count
        action = _failure_action(rule)
        reason = f"sql_expression_failed: {str(exc)[:500]}"
        if action == "fail_batch":
            raise SnapshotRuleExecutionError(
                "transform",
                rule,
                reason,
                transform=transform,
                quality=_empty_quality(),
            ) from exc
        if action == "quarantine":
            transform["quarantinedCount"] += row_count
            return frame.limit(0), _quarantine_all(frame, rule, reason)
        if action == "drop_row":
            transform["droppedCount"] += row_count
            return frame.limit(0), None
        if action == "set_null":
            transform["setNullCount"] += row_count
            return frame.withColumn(output, F.lit(None).cast(_spark_type(rule.get("outputType")))), None
        transform["warnCount"] += row_count
        fallback = F.col(_quote(input_name)) if input_name else F.lit(None)
        return frame.withColumn(output, fallback), None


def _quarantine_all(frame, rule, reason):
    visible_columns = [column for column in frame.columns if not column.startswith("__asklake_")]
    record_columns = [F.col(_quote(column)).alias(column) for column in visible_columns]
    return frame.select(
        _optional_column(frame, ["topic"], "string").alias("topic"),
        _optional_column(frame, ["partition", "kafka_partition"], "int").alias("partition"),
        _optional_column(frame, ["offset", "kafka_offset"], "long").alias("offset"),
        _optional_column(frame, ["kafka_timestamp"], "timestamp").alias("kafka_timestamp"),
        _optional_column(frame, ["raw_payload"], "string").alias("raw_payload"),
        _optional_column(frame, ["event_id"], "string").alias("event_id"),
        F.to_json(F.struct(*record_columns)).alias("record"),
        F.lit(reason).alias("reason"),
        F.lit(str(rule.get("id") or "")).alias("ruleId"),
        F.lit("transform").alias("stage"),
        F.lit(str(_first(rule.get("outputColumns")) or _first(rule.get("inputColumns")) or "")).alias("targetColumn"),
    )


def _empty_transform(configured_count):
    return {
        "appliedStepCount": 0,
        "configuredStepCount": configured_count,
        "droppedCount": 0,
        "errorCount": 0,
        "quarantinedCount": 0,
        "setNullCount": 0,
        "warnCount": 0,
    }


def _empty_quality():
    return {
        "blockingFailures": 0,
        "configuredRuleCount": 0,
        "droppedCount": 0,
        "invalidRowCount": 0,
        "passRate": 100.0,
        "quarantinedCount": 0,
        "setNullCount": 0,
        "status": "pass",
        "summary": "No quality rules",
        "warnCount": 0,
    }


def _merge_transform(target, source):
    for name in (
        "appliedStepCount",
        "droppedCount",
        "errorCount",
        "quarantinedCount",
        "setNullCount",
        "warnCount",
    ):
        target[name] += int(source.get(name) or 0)


def _merge_quarantine(current, next_frame):
    if next_frame is None:
        return current
    return next_frame if current is None else current.unionByName(next_frame, allowMissingColumns=True)


def _failure_action(rule):
    if rule.get("onError") == "fail_batch":
        return "fail_batch"
    if rule.get("onError") == "quarantine":
        return "quarantine"
    if rule.get("failureDisposition") == "drop_row":
        return "drop_row"
    if rule.get("failureDisposition") == "set_null":
        return "set_null"
    return "keep"


def _optional_column(frame, candidates, data_type):
    for candidate in candidates:
        resolved = _resolve_column_name(frame, candidate)
        if resolved:
            return F.col(_quote(resolved)).cast(data_type)
    return F.lit(None).cast(data_type)


def _resolve_column_name(frame, name):
    text = str(name or "")
    if text in frame.columns:
        return text
    normalized = _normalize_name(text)
    return normalized if normalized in frame.columns else ""


def _normalize_name(value):
    return re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "").strip().lower()).strip("_")


def _spark_type(value):
    normalized = str(value or "").lower()
    if "bool" in normalized:
        return "boolean"
    if any(token in normalized for token in ("int", "long", "bigint")):
        return "bigint"
    if any(token in normalized for token in ("float", "double", "decimal", "number", "numeric")):
        return "double"
    if "timestamp" in normalized or "datetime" in normalized:
        return "timestamp"
    if normalized == "date":
        return "date"
    return "string"


def _quote(name):
    return f"`{str(name).replace('`', '``')}`"


def _first(values):
    return values[0] if isinstance(values, list) and values else ""


def _elapsed_ms(started_at):
    return max(0, round((time.monotonic() - started_at) * 1000))
