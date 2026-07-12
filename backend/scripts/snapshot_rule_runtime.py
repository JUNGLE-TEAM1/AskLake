import re

from pyspark.sql import functions as F
from pyspark.sql import types as T


TRANSFORM_OPERATIONS = {
    "cast",
    "copy",
    "default_value",
    "json_extract",
    "lowercase_trim",
    "mask",
    "null_guard",
    "parse_timestamp",
    "rename",
}
QUALITY_OPERATIONS = {"accepted_values", "not_null", "range", "regex"}
ROW_ID = "__asklake_rule_row_id"


class SnapshotRuleExecutionError(RuntimeError):
    def __init__(self, stage, rule, reason, *, transform=None, quality=None):
        super().__init__(f"{stage} rule {rule.get('id') or 'unknown'} failed: {reason}")
        self.failed_stage = stage
        self.quality = quality
        self.rule_id = str(rule.get("id") or "")
        self.transform = transform


def supports_snapshot_rules(rules):
    for rule in rules or []:
        if not rule or rule.get("enabled") is False:
            continue
        kind = str(rule.get("kind") or "")
        operation = str(rule.get("operation") or "")
        if kind == "transform" and operation in TRANSFORM_OPERATIONS:
            continue
        if kind == "quality" and operation in QUALITY_OPERATIONS:
            continue
        return False
    return True


def apply_snapshot_rules(frame, rules):
    canonical_rules = [rule for rule in (rules or []) if isinstance(rule, dict)]
    transforms = [rule for rule in canonical_rules if rule.get("kind") == "transform" and rule.get("enabled") is not False]
    quality_rules = [rule for rule in canonical_rules if rule.get("kind") == "quality" and rule.get("enabled") is not False]
    transform = {
        "appliedStepCount": 0,
        "configuredStepCount": len(transforms),
        "droppedCount": 0,
        "errorCount": 0,
        "quarantinedCount": 0,
        "setNullCount": 0,
        "warnCount": 0,
    }
    quality = {
        "blockingFailures": 0,
        "configuredRuleCount": len(quality_rules),
        "droppedCount": 0,
        "invalidRowCount": 0,
        "passRate": 100.0,
        "quarantinedCount": 0,
        "setNullCount": 0,
        "status": "pass",
        "summary": "Quality rules passed" if quality_rules else "No quality rules",
        "warnCount": 0,
    }
    current = frame.withColumn(ROW_ID, F.monotonically_increasing_id())
    quarantine = None

    for rule in transforms:
        output_name = _normalize_name(_first(rule.get("outputColumns")) or _first(rule.get("inputColumns")))
        if not output_name:
            continue
        row_count = current.count()
        expression, invalid, reason, source = _transform_expression(current, rule)
        invalid_count = current.filter(invalid).count()
        transform["appliedStepCount"] += row_count - invalid_count
        transform["errorCount"] += invalid_count
        action = _failure_action(rule)

        if invalid_count and action == "fail_batch":
            raise SnapshotRuleExecutionError(
                "transform",
                rule,
                reason,
                transform=transform,
                quality=quality,
            )
        if invalid_count and action == "quarantine":
            quarantine = _append_quarantine(
                quarantine,
                _quarantine_rows(current.filter(invalid), "transform", rule, reason),
            )
            transform["quarantinedCount"] += invalid_count
            current = current.filter(~invalid).withColumn(output_name, expression)
            continue
        if invalid_count and action == "drop_row":
            transform["droppedCount"] += invalid_count
            current = current.filter(~invalid).withColumn(output_name, expression)
            continue
        if invalid_count and action == "set_null":
            transform["setNullCount"] += invalid_count
            current = current.withColumn(output_name, F.when(invalid, F.lit(None)).otherwise(expression))
            continue
        if invalid_count:
            transform["warnCount"] += invalid_count
            current = current.withColumn(output_name, F.when(invalid, source).otherwise(expression))
            continue
        current = current.withColumn(output_name, expression)

    quality_input_count = current.count()
    quality["evaluatedRowCount"] = quality_input_count
    flag_names = []
    failure_reasons = []
    flagged = current
    for index, rule in enumerate(quality_rules):
        flag_name = f"__asklake_quality_failure_{index}"
        condition, reason = _quality_failure_condition(flagged, rule)
        flagged = flagged.withColumn(flag_name, condition)
        flag_names.append(flag_name)
        failure_reasons.append(reason)

    if flag_names:
        any_failure = F.col(flag_names[0])
        for flag_name in flag_names[1:]:
            any_failure = any_failure | F.col(flag_name)
        quality["invalidRowCount"] = flagged.filter(any_failure).select(ROW_ID).distinct().count()
    quality["passRate"] = (
        round(((quality_input_count - quality["invalidRowCount"]) / quality_input_count) * 100, 1)
        if quality_input_count
        else 100.0
    )

    blocking_rule = None
    blocking_reason = ""
    for rule, flag_name, reason in zip(quality_rules, flag_names, failure_reasons):
        if _failure_action(rule) != "fail_batch":
            continue
        failed_count = flagged.filter(F.col(flag_name)).count()
        quality["blockingFailures"] += failed_count
        if failed_count and blocking_rule is None:
            blocking_rule = rule
            blocking_reason = reason
    if blocking_rule is not None:
        quality["status"] = "fail"
        quality["summary"] = (
            f"Quality score {quality['passRate']}% - invalid rows {quality['invalidRowCount']} - "
            f"blocking {quality['blockingFailures']}"
        )
        raise SnapshotRuleExecutionError(
            "quality",
            blocking_rule,
            blocking_reason,
            transform=transform,
            quality=quality,
        )

    current = flagged
    for rule, flag_name, reason in zip(quality_rules, flag_names, failure_reasons):
        invalid = F.col(flag_name)
        invalid_count = current.filter(invalid).count()
        if not invalid_count:
            continue
        action = _failure_action(rule)
        if action == "quarantine":
            quarantine = _append_quarantine(
                quarantine,
                _quarantine_rows(current.filter(invalid), "quality", rule, reason),
            )
            quality["quarantinedCount"] += invalid_count
            current = current.filter(~invalid)
            continue
        if action == "drop_row":
            quality["droppedCount"] += invalid_count
            current = current.filter(~invalid)
            continue
        if action == "set_null":
            target = _resolve_column_name(current, _first(rule.get("inputColumns")))
            if target:
                current = current.withColumn(target, F.when(invalid, F.lit(None)).otherwise(F.col(_quote(target))))
            quality["setNullCount"] += invalid_count
            continue
        quality["warnCount"] += invalid_count

    if flag_names:
        current = current.drop(*flag_names)
    quality["status"] = "warn" if quality["invalidRowCount"] else "pass"
    quality["summary"] = (
        f"Quality score {quality['passRate']}% - invalid rows {quality['invalidRowCount']} - "
        f"dropped {quality['droppedCount']} - quarantined {quality['quarantinedCount']}"
        if quality_rules
        else "No quality rules"
    )
    return {
        "frame": current.drop(ROW_ID),
        "quality": quality,
        "quarantine": quarantine.drop(ROW_ID) if quarantine is not None else None,
        "transform": transform,
    }


def _transform_expression(frame, rule):
    input_name = _first(rule.get("inputColumns"))
    resolved = _resolve_column_name(frame, input_name)
    source = F.col(_quote(resolved)) if resolved else F.lit(None)
    operation = str(rule.get("operation") or "")
    parameters = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
    output_type = rule.get("outputType") or parameters.get("targetType")
    missing = _is_missing(source)

    if operation == "null_guard":
        expression, cast_invalid = _cast_column(source, output_type)
        return expression, missing | cast_invalid, "missing_required_value", source
    if operation == "default_value":
        selected = F.when(missing, F.lit(parameters.get("value"))).otherwise(source)
        expression, invalid = _cast_column(selected, output_type)
        return expression, invalid, "default_value_cast_failed", source
    if operation == "lowercase_trim":
        return F.lower(F.trim(source.cast("string"))), F.lit(False), "", source
    if operation == "json_extract":
        expression = F.get_json_object(_json_text(frame, resolved, source), str(parameters.get("path") or "$"))
        return expression, expression.isNull(), "json_path_not_found", source
    if operation == "mask":
        expression = F.regexp_replace(source.cast("string"), r"(\d{3})-?\d{4}-?(\d{4})", "$1-****-$2")
        return expression, F.lit(False), "", source
    if operation == "parse_timestamp":
        expression = F.to_timestamp(source.cast("string"))
        return expression, (~missing) & expression.isNull(), "timestamp_cast_failed", source
    if operation in {"cast", "copy", "rename"}:
        expression, invalid = _cast_column(source, output_type)
        return expression, invalid, "cast_failed", source
    return source, F.lit(True), "unsupported_transform_operation", source


def _cast_column(source, target_type):
    normalized = str(target_type or "").strip().lower()
    missing = _is_missing(source)
    if not normalized:
        return source, F.lit(False)
    text = F.trim(source.cast("string"))
    if "bool" in normalized:
        lowered = F.lower(text)
        expression = (
            F.when(lowered.isin("true", "1", "yes", "y"), F.lit(True))
            .when(lowered.isin("false", "0", "no", "n"), F.lit(False))
            .otherwise(F.lit(None).cast("boolean"))
        )
        return expression, (~missing) & expression.isNull()
    if any(token in normalized for token in ("integer", "int", "long", "bigint")):
        valid = text.rlike(r"^[+-]?\d+$")
        expression = F.when(valid, text.cast("long")).otherwise(F.lit(None).cast("long"))
        return expression, (~missing) & (~valid | expression.isNull())
    if any(token in normalized for token in ("float", "double", "decimal", "number", "numeric", "real")):
        valid = text.rlike(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
        expression = F.when(valid, text.cast("double")).otherwise(F.lit(None).cast("double"))
        return expression, (~missing) & (~valid | expression.isNull())
    if "timestamp" in normalized or "datetime" in normalized:
        expression = F.to_timestamp(text)
        return expression, (~missing) & expression.isNull()
    if normalized == "date":
        expression = F.to_date(text)
        return expression, (~missing) & expression.isNull()
    if any(token in normalized for token in ("json", "array", "struct", "map", "object")):
        return source.cast("string"), F.lit(False)
    return source.cast("string"), F.lit(False)


def _quality_failure_condition(frame, rule):
    target = _resolve_column_name(frame, _first(rule.get("inputColumns")))
    value = F.col(_quote(target)) if target else F.lit(None)
    operation = str(rule.get("operation") or "")
    parameters = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
    if operation == "not_null":
        return _is_missing(value), "missing_required_value"
    if operation == "range":
        text = F.trim(value.cast("string"))
        valid_number = text.rlike(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
        numeric = F.when(valid_number, text.cast("double")).otherwise(F.lit(None).cast("double"))
        condition = numeric.isNull()
        minimum = parameters.get("min")
        maximum = parameters.get("max")
        inclusive = parameters.get("inclusive") is not False
        if minimum not in (None, ""):
            try:
                minimum_value = float(minimum)
            except (TypeError, ValueError):
                return F.lit(True), "numeric_range_check_failed"
            condition = condition | (numeric < F.lit(minimum_value) if inclusive else numeric <= F.lit(minimum_value))
        if maximum not in (None, ""):
            try:
                maximum_value = float(maximum)
            except (TypeError, ValueError):
                return F.lit(True), "numeric_range_check_failed"
            condition = condition | (numeric > F.lit(maximum_value) if inclusive else numeric >= F.lit(maximum_value))
        return condition, "numeric_range_check_failed"
    if operation == "regex":
        pattern = str(parameters.get("pattern") or "")
        try:
            re.compile(pattern)
        except re.error:
            return F.lit(True), "invalid_regex_pattern"
        return value.isNull() | ~value.cast("string").rlike(pattern), "regex_match_failed"
    if operation == "accepted_values":
        values = [str(item) for item in parameters.get("values", [])] if isinstance(parameters.get("values"), list) else []
        return value.isNull() | ~value.cast("string").isin(*values), "value_not_accepted"
    return F.lit(True), "unsupported_quality_operation"


def _quarantine_rows(frame, stage, rule, reason):
    visible_columns = [column for column in frame.columns if not column.startswith("__asklake_quality_failure_")]
    record_columns = [F.col(_quote(column)).alias(column) for column in visible_columns if column != ROW_ID]
    event_id = _resolve_column_name(frame, "event_id")
    return frame.select(
        F.col(ROW_ID),
        (F.col(_quote(event_id)).cast("string") if event_id else F.lit("")).alias("event_id"),
        F.to_json(F.struct(*record_columns)).alias("record"),
        F.lit(reason).alias("reason"),
        F.lit(str(rule.get("id") or "")).alias("ruleId"),
        F.lit(stage).alias("stage"),
        F.lit(str(_first(rule.get("inputColumns")) or _first(rule.get("outputColumns")) or "")).alias("targetColumn"),
    )


def _append_quarantine(current, next_frame):
    return next_frame if current is None else current.unionByName(next_frame)


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


def _is_missing(column):
    return column.isNull() | (F.length(F.trim(column.cast("string"))) == 0)


def _resolve_column_name(frame, name):
    text = str(name or "")
    if text in frame.columns:
        return text
    normalized = _normalize_name(text)
    return normalized if normalized in frame.columns else ""


def _json_text(frame, resolved, source):
    if not resolved:
        return source.cast("string")
    data_type = frame.schema[resolved].dataType
    if isinstance(data_type, (T.ArrayType, T.MapType, T.StructType)):
        return F.to_json(source)
    return source.cast("string")


def _normalize_name(value):
    text = re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "").strip()).strip("_")
    return text


def _quote(name):
    return f"`{str(name).replace('`', '``')}`"


def _first(values):
    return values[0] if isinstance(values, list) and values else ""
