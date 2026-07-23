"""Structured observability for retained compatibility paths.

Compatibility code is sometimes required while persisted jobs and clients are
upgraded. Every production-reachable path must be visible: callers record a
stable path identifier, a bounded reason, and non-sensitive context. Log
drains remain the durable source and can derive deployment-wide metrics from
the structured event; the in-process counter supports health checks and tests.
"""

from __future__ import annotations

from collections import Counter
from enum import StrEnum
import logging
from threading import Lock
from typing import Any, Mapping


class CompatibilityPath(StrEnum):
    CATALOG_SYNTHETIC_LINEAGE = "catalog.synthetic-lineage-fallback"
    CONTINUOUS_LEGACY_ERROR = "continuous.legacy-error-string"
    DASHBOARD_ASSISTANT_DEGRADED = "dashboard-assistant.degraded-no-ai"
    DASHBOARD_LEGACY_COLOR = "dashboard.legacy-color-map"
    ETL_LEGACY_PERMISSION_ROLES = "etl.legacy-permission-roles"
    RULES_LEGACY_ADAPTER = "rules.legacy-draft-adapter"
    SQL_DUCKDB_ENGINE = "sql.duckdb-compatibility-engine"


_logger = logging.getLogger("asklake.compatibility")
_counts: Counter[str] = Counter()
_counts_lock = Lock()


def record_compatibility_path(
    path: CompatibilityPath | str,
    *,
    reason: str,
    context: Mapping[str, Any] | None = None,
) -> int:
    """Record one compatibility-path activation and return its local count."""

    path_id = path.value if isinstance(path, CompatibilityPath) else str(path).strip()
    if not path_id:
        raise ValueError("Compatibility path id must not be empty")
    with _counts_lock:
        _counts[path_id] += 1
        count = _counts[path_id]
    _logger.warning(
        "compatibility_path_used",
        extra={
            "compatibility_context": _bounded_context(context),
            "compatibility_count": count,
            "compatibility_path": path_id,
            "compatibility_reason": str(reason or "unspecified")[:200],
            "event": "compatibility.path.used",
        },
    )
    return count


def compatibility_path_counts() -> dict[str, int]:
    with _counts_lock:
        return dict(sorted(_counts.items()))


def reset_compatibility_path_counts_for_test() -> None:
    """Reset process-local counters. Production code must never call this."""

    with _counts_lock:
        _counts.clear()


def record_legacy_runtime_error_projection(
    metrics: Mapping[str, Any] | None,
    legacy_error: str | None,
    *,
    public_status: str,
) -> None:
    contract = metrics.get("runtimeContract") if isinstance(metrics, Mapping) else None
    structured_error = contract.get("lastError") if isinstance(contract, Mapping) else None
    if legacy_error and not isinstance(structured_error, Mapping):
        record_compatibility_path(
            CompatibilityPath.CONTINUOUS_LEGACY_ERROR,
            reason="legacy runtime error string is being classified",
            context={"publicStatus": public_status},
        )


def _bounded_context(context: Mapping[str, Any] | None) -> dict[str, str | int | float | bool | None]:
    bounded: dict[str, str | int | float | bool | None] = {}
    for key, value in list((context or {}).items())[:12]:
        safe_key = str(key)[:80]
        if value is None or isinstance(value, (bool, int, float)):
            bounded[safe_key] = value
        else:
            bounded[safe_key] = str(value)[:200]
    return bounded
