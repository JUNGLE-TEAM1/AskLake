from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any, Iterable

from app.schemas.etl import (
    CanonicalRuleDraft,
    QualityRuleDraft,
    RuleCompilationIssue,
    RuleCompilationResult,
    SchemaColumnDraft,
    TransformStepDraft,
)


RULE_CONTRACT_VERSION = "1.0"

TRANSFORM_OPERATIONS = {
    "cast",
    "copy",
    "custom_csv_classifier",
    "default_value",
    "json_extract",
    "lowercase_trim",
    "mask",
    "null_guard",
    "parse_timestamp",
    "rename",
    "sql_expression",
    "sql_result_materialize",
    "text_row_analysis",
}
QUALITY_OPERATIONS = {"accepted_values", "not_null", "range", "regex"}
KAFKA_SNAPSHOT_TRANSFORMS = {
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
CONTINUOUS_TRANSFORMS = KAFKA_SNAPSHOT_TRANSFORMS
CONTINUOUS_QUALITY = QUALITY_OPERATIONS
VALID_RULE_KINDS = {"transform", "quality"}
VALID_ERROR_POLICIES = {"fail_batch", "quarantine", "warn"}
VALID_FAILURE_DISPOSITIONS = {"keep", "drop_row", "set_null"}
VALID_SEVERITIES = {"warning", "error"}
PARAMETER_KEYS: dict[tuple[str, str], set[str] | None] = {
    ("transform", "cast"): {"format", "targetType"},
    ("transform", "copy"): set(),
    ("transform", "custom_csv_classifier"): None,
    ("transform", "default_value"): {"value"},
    ("transform", "json_extract"): {"path"},
    ("transform", "lowercase_trim"): set(),
    ("transform", "mask"): {"policy"},
    ("transform", "null_guard"): set(),
    ("transform", "parse_timestamp"): {"format"},
    ("transform", "rename"): set(),
    ("transform", "sql_expression"): {"expression"},
    ("transform", "sql_result_materialize"): None,
    ("transform", "text_row_analysis"): None,
    ("quality", "accepted_values"): {"values"},
    ("quality", "not_null"): set(),
    ("quality", "range"): {"inclusive", "max", "min"},
    ("quality", "regex"): {"pattern"},
}


@dataclass(frozen=True)
class CompiledRuleSet:
    result: RuleCompilationResult
    transform_steps: list[TransformStepDraft]
    quality_rules: list[QualityRuleDraft]


def compile_rule_set(
    *,
    contract_version: str | None = None,
    rules: Iterable[CanonicalRuleDraft | dict[str, Any]] | None,
    transform_steps: Iterable[TransformStepDraft | dict[str, Any]] | None,
    quality_rules: Iterable[QualityRuleDraft | dict[str, Any]] | None,
    schema_columns: Iterable[SchemaColumnDraft | dict[str, Any]] | None,
    transform_output_columns: Iterable[tuple[str, str] | list[str]] | None = None,
    execution_mode: str = "snapshot",
    source_type: str = "",
) -> CompiledRuleSet:
    schema = [_payload(column) for column in (schema_columns or [])]
    declared_outputs = _normalize_output_columns(transform_output_columns)
    canonical_supplied = rules is not None
    canonical_rules = [
        rule if isinstance(rule, CanonicalRuleDraft) else CanonicalRuleDraft.model_validate(rule)
        for rule in (rules or [])
    ]
    if not canonical_supplied:
        canonical_rules = adapt_legacy_rules(
            transform_steps=transform_steps,
            quality_rules=quality_rules,
            schema_columns=schema,
            transform_output_columns=declared_outputs,
        )

    output_types: dict[str, str] = {}
    available_types: dict[str, str] = {}
    for column in schema:
        if column.get("included", True) is False:
            continue
        source = str(column.get("sourceName") or column.get("source_name") or "").strip()
        target = str(column.get("targetName") or column.get("target_name") or source).strip()
        source_logical_type = canonical_schema_type(column.get("sourceType") or column.get("source_type") or column.get("type"))
        target_type = canonical_schema_type(column.get("type"))
        if target:
            output_types[target] = target_type
            available_types[target] = target_type
        if source:
            available_types[source] = source_logical_type
    declared_types = {name: canonical_schema_type(type_) for name, type_ in declared_outputs}

    issues: list[RuleCompilationIssue] = []
    if canonical_supplied and contract_version != RULE_CONTRACT_VERSION:
        code = "RULE_CONTRACT_VERSION_REQUIRED" if contract_version is None else "RULE_CONTRACT_VERSION_UNSUPPORTED"
        issues.append(_issue(
            code,
            "ruleContractVersion",
            "Canonical rules require ruleContractVersion 1.0."
            if contract_version is None
            else f"Unsupported rule contract version: {contract_version}",
        ))
    normalized_rules: list[CanonicalRuleDraft] = []
    seen_ids: set[str] = set()
    kafka_snapshot = execution_mode == "snapshot" and "kafka" in str(source_type or "").lower()

    for index, rule in enumerate(canonical_rules):
        rule_id = str(rule.id or f"rule-{index + 1}").strip()
        kind = str(rule.kind or "").strip()
        operation = normalize_operation(rule.operation, kind)
        inputs = _normalize_names(rule.input_columns)
        outputs = _normalize_names(rule.output_columns)
        parameters = dict(rule.parameters or {})
        on_error = str(rule.on_error or "").strip()
        disposition = str(rule.failure_disposition or "").strip()
        severity = str(rule.severity or ("warning" if kind == "quality" else "")).strip() or None

        if not rule_id:
            rule_id = f"rule-{index + 1}"
            issues.append(_issue("RULE_ID_REQUIRED", "id", "Rule id is required.", rule_id))
        if rule_id in seen_ids:
            issues.append(_issue("RULE_ID_DUPLICATE", "id", f"Duplicate rule id: {rule_id}", rule_id))
        seen_ids.add(rule_id)

        if rule.contract_version != RULE_CONTRACT_VERSION:
            issues.append(_issue(
                "RULE_CONTRACT_VERSION_UNSUPPORTED",
                "contractVersion",
                f"Unsupported rule contract version: {rule.contract_version}",
                rule_id,
            ))
        if kind not in VALID_RULE_KINDS:
            issues.append(_issue("RULE_KIND_UNSUPPORTED", "kind", f"Unsupported rule kind: {kind}", rule_id))
        if on_error not in VALID_ERROR_POLICIES:
            issues.append(_issue("RULE_ERROR_POLICY_UNSUPPORTED", "onError", f"Unsupported onError policy: {on_error}", rule_id))
        if disposition not in VALID_FAILURE_DISPOSITIONS:
            issues.append(_issue(
                "RULE_FAILURE_DISPOSITION_UNSUPPORTED",
                "failureDisposition",
                f"Unsupported failureDisposition: {disposition}",
                rule_id,
            ))
        if on_error in {"fail_batch", "quarantine"} and disposition in {"drop_row", "set_null"}:
            issues.append(_issue(
                "RULE_FAILURE_POLICY_CONFLICT",
                "failureDisposition",
                f"{on_error} requires failureDisposition 'keep'.",
                rule_id,
            ))
        if severity is not None and severity not in VALID_SEVERITIES:
            issues.append(_issue("RULE_SEVERITY_UNSUPPORTED", "severity", f"Unsupported severity: {severity}", rule_id))

        known_operations = TRANSFORM_OPERATIONS if kind == "transform" else QUALITY_OPERATIONS if kind == "quality" else set()
        if operation not in known_operations:
            issues.append(_issue("RULE_OPERATION_UNSUPPORTED", "operation", f"Unsupported {kind or 'unknown'} operation: {rule.operation}", rule_id))

        allowed_parameter_keys = PARAMETER_KEYS.get((kind, operation))
        if allowed_parameter_keys is not None:
            unsupported_keys = sorted(set(parameters) - allowed_parameter_keys)
            if unsupported_keys:
                issues.append(_issue(
                    "RULE_PARAMETER_UNSUPPORTED",
                    "parameters",
                    f"Unsupported parameters for {operation}: {', '.join(unsupported_keys)}",
                    rule_id,
                ))

        if rule.enabled:
            if execution_mode == "continuous" and (
                (kind == "transform" and operation not in CONTINUOUS_TRANSFORMS)
                or (kind == "quality" and operation not in CONTINUOUS_QUALITY)
            ):
                issues.append(_issue(
                    "RULE_EXECUTION_MODE_UNSUPPORTED",
                    "operation",
                    f"Continuous does not support stateful or engine-specific {kind} operation: {operation}",
                    rule_id,
                ))
            elif kafka_snapshot and rule.kind == "transform" and operation not in KAFKA_SNAPSHOT_TRANSFORMS:
                issues.append(_issue(
                    "RULE_EXECUTION_MODE_UNSUPPORTED",
                    "operation",
                    f"Kafka Snapshot does not support transform operation: {operation}",
                    rule_id,
                ))

            if len(inputs) != 1:
                issues.append(_issue("RULE_INPUT_ARITY", "inputColumns", "Current rule contract requires exactly one input column.", rule_id))
            for input_name in inputs:
                if available_input_type(available_types, input_name) is None:
                    issues.append(_issue("RULE_INPUT_NOT_FOUND", "inputColumns", f"Rule input column does not exist: {input_name}", rule_id))

            if kind == "transform":
                if len(outputs) != 1:
                    issues.append(_issue("RULE_OUTPUT_ARITY", "outputColumns", "Transform rules require exactly one output column.", rule_id))
                _validate_rule_parameters(operation, parameters, rule_id, issues)
            elif kind == "quality" and outputs:
                issues.append(_issue("RULE_OUTPUT_NOT_ALLOWED", "outputColumns", "Quality rules do not create output columns.", rule_id))
            elif kind == "quality":
                _validate_rule_parameters(operation, parameters, rule_id, issues)

        input_type = (available_input_type(available_types, inputs[0]) or "String") if inputs else "String"
        output_type = infer_output_type(operation, rule.output_type, parameters, input_type, outputs, declared_types)
        normalized_rule = CanonicalRuleDraft(
            contract_version="1.0",
            enabled=rule.enabled,
            failure_disposition=disposition,
            id=rule_id,
            input_columns=inputs,
            kind=kind,
            label=rule.label,
            on_error=on_error,
            operation=operation,
            output_columns=outputs,
            output_type=output_type if kind == "transform" else None,
            parameters=parameters,
            severity=severity,
        )
        normalized_rules.append(normalized_rule)

        if rule.enabled and kind == "transform" and len(outputs) == 1:
            available_types[outputs[0]] = output_type or "String"
            output_types[outputs[0]] = output_type or "String"

    full_sql_transform = any(
        rule.enabled
        and rule.kind == "transform"
        and rule.operation == "sql_expression"
        and str(rule.parameters.get("expression") or "").lstrip().lower().startswith(("select", "with"))
        for rule in normalized_rules
    )
    if full_sql_transform and not declared_types:
        issues.append(_issue(
            "RULE_OUTPUT_SCHEMA_REQUIRED",
            "transformOutputColumns",
            "Full SQL transforms require a validated output schema.",
        ))

    legacy_steps = [canonical_transform_to_legacy(rule) for rule in normalized_rules if rule.kind == "transform"]
    legacy_quality = [canonical_quality_to_legacy(rule) for rule in normalized_rules if rule.kind == "quality"]
    result = RuleCompilationResult(
        contract_version="1.0",
        issues=issues,
        output_schema=list((declared_types if full_sql_transform else output_types).items()),
        rules=normalized_rules,
        status="fail" if issues else "pass",
    )
    return CompiledRuleSet(result=result, transform_steps=legacy_steps, quality_rules=legacy_quality)


def adapt_legacy_rules(
    *,
    transform_steps: Iterable[TransformStepDraft | dict[str, Any]] | None,
    quality_rules: Iterable[QualityRuleDraft | dict[str, Any]] | None,
    schema_columns: Iterable[SchemaColumnDraft | dict[str, Any]] | None,
    transform_output_columns: Iterable[tuple[str, str] | list[str]] | None = None,
) -> list[CanonicalRuleDraft]:
    schema = [_payload(column) for column in (schema_columns or [])]
    type_by_name: dict[str, str] = {}
    for column in schema:
        source = str(column.get("sourceName") or column.get("source_name") or "").strip()
        target = str(column.get("targetName") or column.get("target_name") or source).strip()
        logical_type = canonical_schema_type(column.get("type"))
        if source:
            type_by_name[source] = logical_type
        if target:
            type_by_name[target] = logical_type
    type_by_name.update({name: canonical_schema_type(type_) for name, type_ in _normalize_output_columns(transform_output_columns)})

    adapted: list[CanonicalRuleDraft] = []
    for index, raw_step in enumerate(transform_steps or []):
        step = _payload(raw_step)
        operation = normalize_operation(step.get("operation") or step.get("kind"), "transform")
        input_name = str(step.get("input") or "").strip()
        output_name = str(step.get("output") or input_name).strip()
        on_error, disposition = legacy_failure_policy(step.get("onError") or step.get("on_error"))
        canonical_parameters = step.get("canonicalParameters", step.get("canonical_parameters"))
        parameters = dict(canonical_parameters) if isinstance(canonical_parameters, dict) else legacy_parameters(operation, step.get("params"), "transform")
        adapted.append(CanonicalRuleDraft(
            enabled=step.get("enabled", True) is not False,
            failure_disposition=disposition,
            id=str(step.get("id") or f"transform-{index + 1}"),
            input_columns=[input_name] if input_name else [],
            kind="transform",
            label=str(step.get("label") or "") or None,
            on_error=on_error,
            operation=operation,
            output_columns=[output_name] if output_name else [],
            output_type=infer_output_type(operation, type_by_name.get(output_name), parameters, type_by_name.get(input_name, "String"), [output_name], type_by_name),
            parameters=parameters,
        ))

    for index, raw_rule in enumerate(quality_rules or []):
        rule = _payload(raw_rule)
        operation = normalize_operation(rule.get("validationType") or rule.get("validation_type") or rule.get("kind"), "quality")
        target = str(rule.get("targetColumn") or rule.get("target_column") or "").strip()
        on_error, disposition = legacy_failure_policy(rule.get("failureAction") or rule.get("failure_action"))
        canonical_parameters = rule.get("canonicalParameters", rule.get("canonical_parameters"))
        adapted.append(CanonicalRuleDraft(
            enabled=rule.get("enabled", True) is not False,
            failure_disposition=disposition,
            id=str(rule.get("id") or f"quality-{index + 1}"),
            input_columns=[target] if target else [],
            kind="quality",
            label=None,
            on_error=on_error,
            operation=operation,
            output_columns=[],
            parameters=dict(canonical_parameters) if isinstance(canonical_parameters, dict) else legacy_parameters(operation, rule.get("params"), "quality"),
            severity="error" if str(rule.get("severity") or "").lower() == "error" else "warning",
        ))
    return adapted


def canonical_transform_to_legacy(rule: CanonicalRuleDraft) -> TransformStepDraft:
    input_name = rule.input_columns[0] if rule.input_columns else ""
    output_name = rule.output_columns[0] if rule.output_columns else input_name
    operation, kind = legacy_transform_operation(rule.operation, rule.output_type)
    return TransformStepDraft(
        canonical_parameters=dict(rule.parameters or {}),
        enabled=rule.enabled,
        id=rule.id,
        input=input_name,
        kind=kind,
        label=rule.label or f"{operation}: {input_name} -> {output_name}",
        on_error=canonical_failure_policy(rule),
        operation=operation,
        output=output_name,
        params=legacy_parameter_string(rule),
    )


def canonical_quality_to_legacy(rule: CanonicalRuleDraft) -> QualityRuleDraft:
    target = rule.input_columns[0] if rule.input_columns else ""
    validation_type, kind = legacy_quality_operation(rule.operation)
    return QualityRuleDraft(
        canonical_parameters=dict(rule.parameters or {}),
        enabled=rule.enabled,
        failure_action=canonical_failure_policy(rule),
        id=rule.id,
        kind=kind,
        params=legacy_parameter_string(rule),
        severity="Error" if rule.severity == "error" else "Warning",
        target_column=target,
        validation_type=validation_type,
    )


def normalize_operation(value: Any, kind: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
    if kind == "quality":
        if "not_null" in normalized or normalized == "notnull":
            return "not_null"
        if "accepted" in normalized:
            return "accepted_values"
        if "range" in normalized:
            return "range"
        if "regex" in normalized:
            return "regex"
        if "unique" in normalized:
            return "unique"
        return normalized
    if "sql_result_materialize" in normalized:
        return "sql_result_materialize"
    if "sql_expression" in normalized:
        return "sql_expression"
    if "review_row_analysis" in normalized or "text_row_analysis" in normalized or "review_analyze" in normalized or "text_analyze" in normalized:
        return "text_row_analysis"
    if "custom_csv_classifier" in normalized or normalized == "csv_classifier":
        return "custom_csv_classifier"
    if "default" in normalized:
        return "default_value"
    if "null_guard" in normalized or "not_null" in normalized:
        return "null_guard"
    if "json" in normalized:
        return "json_extract"
    if "lower" in normalized or "trim" in normalized:
        return "lowercase_trim"
    if "decimal" in normalized or normalized.startswith("cast") or normalized == "cast":
        return "cast"
    if "timestamp" in normalized or normalized in {"date", "parse_date"}:
        return "parse_timestamp"
    if "mask" in normalized:
        return "mask"
    if "rename" in normalized:
        return "rename"
    if normalized in {"copy", "derive", ""}:
        return "copy"
    return normalized


def legacy_failure_policy(value: Any) -> tuple[str, str]:
    normalized = str(value or "Warn").strip().lower()
    if "fail" in normalized:
        return "fail_batch", "keep"
    if "quarantine" in normalized:
        return "quarantine", "keep"
    if "drop" in normalized:
        return "warn", "drop_row"
    if "null" in normalized:
        return "warn", "set_null"
    return "warn", "keep"


def canonical_failure_policy(rule: CanonicalRuleDraft) -> str:
    if rule.failure_disposition == "drop_row":
        return "Drop Row"
    if rule.failure_disposition == "set_null":
        return "Set Null"
    if rule.on_error == "fail_batch":
        return "Fail Run"
    if rule.on_error == "quarantine":
        return "Quarantine"
    return "Warn"


def legacy_parameters(operation: str, raw_value: Any, kind: str) -> dict[str, Any]:
    if isinstance(raw_value, dict):
        return dict(raw_value)
    raw = str(raw_value or "").strip()
    parsed = _json_object(raw)
    if parsed is not None:
        return parsed
    if kind == "quality":
        if operation == "regex":
            return {"pattern": raw or r"^[^\s@]+@[^\s@]+\.[^\s@]+$"}
        if operation == "accepted_values":
            return {
                "values": [item.strip() for item in raw.split(",") if item.strip()]
                if raw
                else ["KOR", "JPN", "USA", "KR", "US"]
            }
        if operation == "range" and raw:
            bounds = [item.strip() for item in raw.split(",")]
            return {"min": bounds[0], **({"max": bounds[1]} if len(bounds) > 1 else {})}
        if operation == "range":
            return {"min": 0}
        return {}
    if operation == "json_extract":
        return {"path": raw or "$.value"}
    if operation == "cast":
        return {"format": raw, "targetType": canonical_schema_type(raw or "Double")}
    if operation == "parse_timestamp":
        return {"format": raw or "UTC"}
    if operation == "mask":
        return {"policy": raw or "keep first 3 digits"}
    if operation == "default_value":
        return {"value": raw}
    if operation == "sql_expression":
        return {"expression": raw}
    if raw and operation not in {"lowercase_trim", "null_guard", "rename", "copy"}:
        return {"value": raw}
    return {}


def infer_output_type(
    operation: str,
    declared_type: Any,
    parameters: dict[str, Any],
    input_type: str,
    outputs: list[str],
    declared_types: dict[str, str],
) -> str:
    if declared_type:
        return canonical_schema_type(declared_type)
    if outputs and outputs[0] in declared_types:
        return declared_types[outputs[0]]
    if operation == "cast":
        return canonical_schema_type(parameters.get("targetType") or parameters.get("format") or "Double")
    if operation == "parse_timestamp":
        return "Timestamp"
    if operation in {"json_extract", "lowercase_trim", "mask", "custom_csv_classifier", "text_row_analysis"}:
        return "String"
    return canonical_schema_type(input_type)


def canonical_schema_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if any(token in normalized for token in ["json", "array", "struct", "map", "object"]):
        return "JSON"
    if "bool" in normalized:
        return "Boolean"
    if "timestamp" in normalized or "datetime" in normalized:
        return "Timestamp"
    if normalized == "date":
        return "Date"
    if any(token in normalized for token in ["bigint", "int64", "long"]):
        return "Long"
    if any(token in normalized for token in ["smallint", "tinyint", "int32", "integer"]):
        return "Integer"
    if normalized == "int":
        return "Integer"
    if any(token in normalized for token in ["float", "double", "decimal", "numeric", "number", "real"]):
        return "Double"
    return "String"


def available_input_type(available_types: dict[str, str], name: str) -> str | None:
    if name in available_types:
        return available_types[name]
    root, separator, _path = str(name or "").partition(".")
    if separator and available_types.get(root) == "JSON":
        return "String"
    return None


def _validate_rule_parameters(
    operation: str,
    parameters: dict[str, Any],
    rule_id: str,
    issues: list[RuleCompilationIssue],
) -> None:
    if operation == "json_extract":
        path = str(parameters.get("path") or "").strip()
        if not path:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.path", "JSON extract path is required.", rule_id))
        elif not path.startswith("$"):
            issues.append(_issue("RULE_PARAMETER_INVALID", "parameters.path", "JSON extract path must start with '$'.", rule_id))
    if operation == "sql_expression" and not str(parameters.get("expression") or "").strip():
        issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.expression", "SQL expression is required.", rule_id))
    if operation == "regex":
        pattern = str(parameters.get("pattern") or "")
        if not pattern:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.pattern", "Regex pattern is required.", rule_id))
        else:
            try:
                re.compile(pattern)
            except re.error:
                issues.append(_issue("RULE_PARAMETER_INVALID", "parameters.pattern", "Regex pattern is invalid.", rule_id))
    if operation == "accepted_values":
        values = parameters.get("values")
        normalized = [str(value).strip() for value in values if str(value).strip()] if isinstance(values, list) else []
        if not normalized:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.values", "Accepted values require at least one value.", rule_id))
    if operation == "range":
        has_min = parameters.get("min") not in (None, "")
        has_max = parameters.get("max") not in (None, "")
        if not has_min and not has_max:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters", "Range requires min or max.", rule_id))
        else:
            try:
                minimum = float(parameters["min"]) if has_min else float("-inf")
                maximum = float(parameters["max"]) if has_max else float("inf")
                valid = math.isfinite(minimum) if has_min else True
                valid = valid and (math.isfinite(maximum) if has_max else True) and minimum <= maximum
            except (TypeError, ValueError):
                valid = False
            if not valid:
                issues.append(_issue("RULE_PARAMETER_INVALID", "parameters", "Range min/max must be finite numbers and min must not exceed max.", rule_id))
        if "inclusive" in parameters and not isinstance(parameters.get("inclusive"), bool):
            issues.append(_issue("RULE_PARAMETER_INVALID", "parameters.inclusive", "Range inclusive must be boolean.", rule_id))
    if operation == "mask":
        policy = str(parameters.get("policy") or "").strip().lower()
        if not policy:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.policy", "Mask policy is required.", rule_id))
        elif policy not in {"phone", "keep first 3 digits"}:
            issues.append(_issue("RULE_PARAMETER_INVALID", "parameters.policy", "Mask policy must be phone.", rule_id))
    if operation == "parse_timestamp":
        timestamp_format = str(parameters.get("format") or "").strip().upper()
        if not timestamp_format:
            issues.append(_issue("RULE_PARAMETER_REQUIRED", "parameters.format", "Timestamp format is required.", rule_id))
        elif timestamp_format not in {"ISO-8601", "UTC"}:
            issues.append(_issue("RULE_PARAMETER_INVALID", "parameters.format", "Timestamp format must be ISO-8601.", rule_id))


def legacy_transform_operation(operation: str, output_type: str | None) -> tuple[str, str]:
    mapping = {
        "copy": ("Copy", "derive"),
        "custom_csv_classifier": ("Custom CSV Classifier", "derive"),
        "default_value": ("Default Value", "derive"),
        "json_extract": ("Extract JSONPath", "jsonPath"),
        "lowercase_trim": ("Lowercase + Trim", "trim"),
        "mask": ("Mask", "mask"),
        "null_guard": ("Null Guard", "derive"),
        "parse_timestamp": ("Parse Timestamp", "cast"),
        "rename": ("Rename", "rename"),
        "sql_expression": ("SQL Expression", "derive"),
        "sql_result_materialize": ("SQL_RESULT_MATERIALIZE", "derive"),
        "text_row_analysis": ("Text Row Analysis", "derive"),
    }
    if operation == "cast":
        return (f"Cast {output_type or 'Double'}", "cast")
    return mapping.get(operation, (operation, "derive"))


def legacy_quality_operation(operation: str) -> tuple[str, str]:
    return {
        "accepted_values": ("Accepted Values", "acceptedValues"),
        "not_null": ("Not Null", "notNull"),
        "range": ("Range Check", "range"),
        "regex": ("Regex Match", "regex"),
        "unique": ("Unique", "unique"),
    }.get(operation, (operation, operation))


def legacy_parameter_string(rule: CanonicalRuleDraft) -> str:
    parameters = rule.parameters or {}
    if rule.kind == "quality":
        return json.dumps(parameters, ensure_ascii=False, separators=(",", ":")) if parameters else ""
    if rule.operation == "json_extract":
        return str(parameters.get("path") or "$.value")
    if rule.operation == "cast":
        return str(parameters.get("format") or parameters.get("targetType") or rule.output_type or "Double")
    if rule.operation == "parse_timestamp":
        return str(parameters.get("format") or "UTC")
    if rule.operation == "mask":
        return str(parameters.get("policy") or "keep first 3 digits")
    if rule.operation == "default_value":
        value = parameters.get("value")
        return "" if value is None else str(value)
    if rule.operation == "sql_expression":
        return str(parameters.get("expression") or "")
    if rule.operation == "lowercase_trim":
        return "lower(), trim()"
    return json.dumps(parameters, ensure_ascii=False, separators=(",", ":")) if parameters else ""


def _normalize_names(values: Iterable[Any]) -> list[str]:
    return list(dict.fromkeys(str(value or "").strip() for value in values if str(value or "").strip()))


def _normalize_output_columns(values: Iterable[tuple[str, str] | list[str]] | None) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for value in values or []:
        if not isinstance(value, (list, tuple)) or not value:
            continue
        name = str(value[0] or "").strip()
        if name:
            result.append((name, str(value[1] if len(value) > 1 else "String")))
    return result


def _payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    return {}


def _json_object(value: str) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _issue(code: str, field: str, message: str, rule_id: str | None = None) -> RuleCompilationIssue:
    return RuleCompilationIssue(code=code, field=field, message=message, rule_id=rule_id)
