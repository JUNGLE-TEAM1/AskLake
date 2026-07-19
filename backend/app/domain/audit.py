from enum import StrEnum


class AuditTargetType(StrEnum):
    ETL_JOB = "etl_job"
    DATASET = "dataset"
    DASHBOARD = "dashboard"
    QUERY_RUN = "query_run"
    AI_MODULE = "ai_module"
    ADMIN_MODULE = "admin_module"
    UI = "ui"
    AUTH = "auth"
    USER = "user"
    GROUP = "group"
    UNKNOWN = "unknown"


AUDIT_TARGET_TYPES = frozenset(target_type.value for target_type in AuditTargetType)
KNOWN_AUDIT_TARGET_TYPES = frozenset(
    target_type.value
    for target_type in AuditTargetType
    if target_type is not AuditTargetType.UNKNOWN
)


def normalize_audit_target_type(value: str | AuditTargetType) -> AuditTargetType:
    normalized = value.value if isinstance(value, AuditTargetType) else value.strip()
    try:
        return AuditTargetType(normalized)
    except ValueError:
        return AuditTargetType.UNKNOWN


def require_writable_audit_target_type(value: AuditTargetType) -> AuditTargetType:
    if not isinstance(value, AuditTargetType):
        raise TypeError("Audit target type writes require AuditTargetType")
    if value is AuditTargetType.UNKNOWN:
        raise ValueError("unknown is reserved for legacy audit read compatibility")
    return value
