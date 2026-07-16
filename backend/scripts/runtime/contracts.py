"""Shared, Spark-free contracts for AskLake runtime entrypoints."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping
from uuid import uuid4


RUNTIME_REPORT_SCHEMA_VERSION = 1
CHECKPOINT_CONTRACT_SCHEMA_VERSION = 1
BATCH_MANIFEST_SCHEMA_VERSION = 1


def json_object_env(name: str, *, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    source = environ if environ is not None else os.environ
    try:
        value = json.loads(source.get(name, "{}"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def json_array_env(name: str, *, environ: Mapping[str, str] | None = None) -> list[Any]:
    source = environ if environ is not None else os.environ
    try:
        value = json.loads(source.get(name, "[]"))
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def bounded_int_env(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
    environ: Mapping[str, str] | None = None,
) -> int:
    source = environ if environ is not None else os.environ
    try:
        value = int(source.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def required_env(name: str, *, environ: Mapping[str, str] | None = None) -> str:
    source = environ if environ is not None else os.environ
    value = source.get(name)
    if not value:
        raise ValueError(f"Missing required environment variable: {name}")
    return value


def load_json_env(
    name: str,
    fallback: list[Any],
    *,
    environ: Mapping[str, str] | None = None,
) -> list[Any]:
    source = environ if environ is not None else os.environ
    raw = source.get(name)
    if raw is None or raw == "":
        return fallback
    value = json.loads(raw.lstrip("\ufeff"))
    return value if isinstance(value, list) else fallback


def load_spark_job_manifest(*, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    source = environ if environ is not None else os.environ
    raw_path = source.get("ASKLAKE_SPARK_JOB_MANIFEST_FILE") or source.get(
        "ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE"
    )
    if not raw_path:
        return {}
    try:
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(
    path: str | Path,
    payload: dict[str, Any],
    *,
    schema_field: str | None = None,
    schema_version: int = RUNTIME_REPORT_SCHEMA_VERSION,
) -> dict[str, Any]:
    target = Path(path)
    document = dict(payload)
    if schema_field:
        document.setdefault(schema_field, schema_version)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return document


def read_versioned_json(
    path: str | Path,
    *,
    schema_field: str,
    accepted_versions: tuple[int, ...] = (0, RUNTIME_REPORT_SCHEMA_VERSION),
) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Runtime JSON document must contain an object.")
    raw_version = payload.get(schema_field, 0)
    try:
        version = int(raw_version)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {schema_field}: {raw_version}") from exc
    if version not in accepted_versions:
        raise ValueError(f"Unsupported {schema_field}: {version}")
    return payload


def write_report(path: str | Path | None, result: dict[str, Any]) -> None:
    if not path:
        return
    atomic_write_json(
        path,
        result,
        schema_field="runtimeReportSchemaVersion",
        schema_version=RUNTIME_REPORT_SCHEMA_VERSION,
    )


def append_secondary_error(
    payload: dict[str, Any],
    error: BaseException,
    *,
    stage: str,
) -> None:
    errors = payload.setdefault("secondaryErrors", [])
    errors.append({
        "errorType": type(error).__name__,
        "message": str(error)[:2000],
        "stage": stage,
    })


@dataclass(slots=True)
class ShutdownCoordinator:
    """Own graceful-stop intent without importing Spark or signal modules."""

    requested: bool = False

    def request_stop(self, query: Any | None) -> None:
        self.requested = True
        if query is not None:
            query.stop()
