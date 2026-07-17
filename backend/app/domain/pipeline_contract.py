"""Pure validation rules for persisted ETL pipeline contracts.

The HTTP/service layer translates these violations to ``ApiError``.  Keeping
the rules here makes create, update, review, and future import paths share the
same policy without depending on FastAPI or a database session.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True, slots=True)
class PipelineContractViolation:
    code: str
    message: str
    details: dict[str, Any] | None = None


def create_request_violations(
    request: Any,
    *,
    normalize_column_name: Callable[[str], str],
) -> list[PipelineContractViolation]:
    violations = permission_grant_violations(getattr(request, "permission_grants", None))
    missing: list[str] = []
    for attribute, field in (
        ("job_name", "jobName"),
        ("source_type", "sourceType"),
        ("source_label", "sourceLabel"),
        ("target_dataset", "targetDataset"),
        ("target_layer", "targetLayer"),
        ("owner", "owner"),
    ):
        if not str(getattr(request, attribute, "") or "").strip():
            missing.append(field)

    source_type = str(getattr(request, "source_type", "") or "")
    execution_mode = str(getattr(request, "execution_mode", "snapshot") or "snapshot")
    target_format = str(getattr(request, "target_format", "") or "")
    if execution_mode == "continuous":
        if "kafka" not in source_type.lower():
            missing.append("continuousKafkaSource")
        if target_format.lower() != "parquet":
            missing.append("continuousTargetFormat=parquet")

    parsing = getattr(request, "record_parsing", None)
    if parsing is not None and bool(getattr(parsing, "enabled", False)):
        columns = list(getattr(parsing, "columns", None) or [])
        parsing_names = [
            normalize_column_name(str(getattr(column, "name", "") or ""))
            for column in columns
        ]
        if source_type != "File / S3" and "kafka" not in source_type.lower():
            missing.append("recordParsingSource=File / S3 or Kafka")
        expected_count = int(getattr(parsing, "expected_field_count", 0) or 0)
        if expected_count <= 0:
            missing.append("recordParsing.expectedFieldCount")
        if len(columns) != expected_count:
            missing.append("recordParsing.columns")
        if any(not name for name in parsing_names) or len(set(parsing_names)) != len(parsing_names):
            missing.append("recordParsing.columns[uniqueName]")

    schema_columns = list(getattr(request, "schema_columns", None) or [])
    if not schema_columns:
        missing.append("schemaColumns")
    elif not any(
        bool(getattr(column, "included", False))
        and str(getattr(column, "target_name", "") or "").strip()
        for column in schema_columns
    ):
        missing.append("schemaColumns[included]")

    target_violation = target_contract_violation(
        source_type=source_type,
        execution_mode=execution_mode,
        target_layer=str(getattr(request, "target_layer", "") or ""),
        target_format=target_format,
    )
    if target_violation is not None:
        violations.append(target_violation)
    if missing:
        violations.append(PipelineContractViolation(
            code="VALIDATION_ERROR",
            message=f"Missing required fields: {', '.join(missing)}",
            details={"missingFields": missing},
        ))
    return violations


def update_request_violations(request: Any) -> list[PipelineContractViolation]:
    violations = permission_grant_violations(getattr(request, "permission_grants", None))
    missing: list[str] = []
    for attribute, field in (
        ("job_name", "jobName"),
        ("target_dataset", "targetDataset"),
        ("target_layer", "targetLayer"),
        ("owner", "owner"),
    ):
        if not str(getattr(request, attribute, "") or "").strip():
            missing.append(field)
    schema_columns = list(getattr(request, "schema_columns", None) or [])
    if not schema_columns:
        missing.append("schemaColumns")
    elif not any(
        bool(getattr(column, "included", False))
        and str(getattr(column, "target_name", "") or "").strip()
        for column in schema_columns
    ):
        missing.append("schemaColumns[included]")
    if missing:
        violations.append(PipelineContractViolation(
            code="VALIDATION_ERROR",
            message=f"Missing required fields: {', '.join(missing)}",
            details={"missingFields": missing},
        ))
    return violations


def permission_grant_violations(grants: list[Any] | None) -> list[PipelineContractViolation]:
    violations: list[PipelineContractViolation] = []
    for index, grant in enumerate(grants or []):
        principal_type = str(getattr(grant, "principal_type", "") or "").strip()
        principal_id = str(getattr(grant, "principal_id", "") or "").strip()
        actions = list(getattr(grant, "actions", None) or [])
        if principal_type != "public" and not principal_id:
            violations.append(PipelineContractViolation(
                code="VALIDATION_ERROR",
                message="permissionGrants principalId is required",
                details={"grantIndex": index},
            ))
        if not actions:
            violations.append(PipelineContractViolation(
                code="VALIDATION_ERROR",
                message="permissionGrants actions must include at least one action",
                details={"grantIndex": index},
            ))
    return violations


def target_contract_violation(
    *,
    source_type: str,
    execution_mode: str,
    target_layer: str,
    target_format: str,
) -> PipelineContractViolation | None:
    if "kafka" not in str(source_type or "").lower():
        return None
    normalized_mode = str(execution_mode or "snapshot").lower()
    normalized_layer = str(target_layer or "").upper()
    normalized_format = str(target_format or "").lower()
    if normalized_mode == "continuous":
        if normalized_format == "parquet":
            return None
        return PipelineContractViolation(
            code="TARGET_FORMAT_UNSUPPORTED",
            message="Kafka Continuous target format must be parquet.",
            details={"executionMode": normalized_mode, "supportedFormats": ["parquet"]},
        )
    if normalized_layer not in {"RAW", "BRONZE", "SILVER"}:
        return PipelineContractViolation(
            code="TARGET_LAYER_UNSUPPORTED",
            message="Kafka Snapshot target layer must be RAW, BRONZE, or SILVER.",
            details={
                "executionMode": normalized_mode,
                "supportedLayers": ["RAW", "BRONZE", "SILVER"],
            },
        )
    if normalized_format != "jsonl":
        return PipelineContractViolation(
            code="TARGET_FORMAT_UNSUPPORTED",
            message="Kafka Snapshot target format must be jsonl.",
            details={"executionMode": normalized_mode, "supportedFormats": ["jsonl"]},
        )
    return None
