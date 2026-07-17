"""Pure RAG parent-document contract shared by Spark staging and tests.

This module deliberately has no Spark or application imports.  The parent
stage is the deterministic boundary between Catalog rows and later AI work:
Spark may normalize and persist rows here, but it must not call an LLM.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable


RAG_PARENT_SCHEMA_VERSION = "rag-parent-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
FIELD_RENDERING_VERSION = "field_blocks_v1"
CHUNKING_VERSION = "rag-chunk-v3"
DEFAULT_CHUNK_TARGET_TOKENS = 800
DEFAULT_CHUNK_OVERLAP_TOKENS = 400
DEFAULT_CHUNK_MAX_TOKENS = 1200
DEFAULT_CALLBACK_MAX_RESPONSE_BYTES = 1024 * 1024
RAG_STAGE_ORDER = {
    "queued": 0,
    "staging": 1,
    "chunking": 2,
    "embedding": 3,
    "indexing": 4,
    "validating": 5,
    "ready": 6,
}


class RagCallbackTransportError(RuntimeError):
    """The control plane did not durably acknowledge a callback."""


class RagStageRejectedError(RuntimeError):
    """The control plane fenced this job because it is no longer current."""


class RagJobAlreadyComplete(RuntimeError):
    """A retried physical task belongs to a job that is already ready."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: Any) -> str:
    payload = value if isinstance(value, bytes) else canonical_json(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant {value}")


def post_rag_callback(
    url: str,
    token: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: int = 30,
    max_attempts: int = 3,
    max_response_bytes: int = DEFAULT_CALLBACK_MAX_RESPONSE_BYTES,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Post an idempotent callback with bounded transport retries.

    Stage callbacks are durable control-plane fences.  A Spark stage must not
    continue merely because the acknowledgement was lost, so retry exhaustion
    is an explicit error instead of a best-effort success.
    """

    callback_url = str(url or "").strip()
    callback_token = str(token or "").strip()
    if not callback_url or not callback_token:
        raise RagCallbackTransportError("RAG_CALLBACK_NOT_CONFIGURED")
    attempts = max(1, min(int(max_attempts), 5))
    timeout = max(1, min(int(timeout_seconds), 300))
    response_limit = max(1024, min(int(max_response_bytes), 4 * 1024 * 1024))
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    last_error: BaseException | None = None

    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            callback_url,
            data=encoded,
            method="POST",
            headers={
                "Authorization": f"Bearer {callback_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                declared_length = response.headers.get("Content-Length")
                if declared_length and int(declared_length) > response_limit:
                    raise RagCallbackTransportError("RAG_CALLBACK_RESPONSE_TOO_LARGE")
                raw = response.read(response_limit + 1)
                if len(raw) > response_limit:
                    raise RagCallbackTransportError("RAG_CALLBACK_RESPONSE_TOO_LARGE")
        except urllib.error.HTTPError as exc:
            detail = exc.read(2000).decode("utf-8", "replace")
            last_error = exc
            try:
                error_payload = json.loads(detail, parse_constant=_reject_json_constant)
            except (json.JSONDecodeError, ValueError):
                error_payload = {}
            error = error_payload.get("error") if isinstance(error_payload, dict) else None
            details = error.get("details") if isinstance(error, dict) and isinstance(error.get("details"), dict) else {}
            code = str(error.get("code") or "") if isinstance(error, dict) else ""
            message = str(error.get("message") or detail) if isinstance(error, dict) else detail
            if (
                code in {"rag_job_superseded", "rag_activation_rejected"}
                or (details.get("stopDag") is True and details.get("retryable") is False)
            ):
                raise RagStageRejectedError(message or code) from exc
            if (exc.code == 429 or exc.code >= 500) and attempt < attempts:
                sleep(min(4.0, float(2 ** (attempt - 1))))
                continue
            raise RagCallbackTransportError(
                f"RAG callback failed with HTTP {exc.code}: {detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < attempts:
                sleep(min(4.0, float(2 ** (attempt - 1))))
                continue
            break

        try:
            value = json.loads(raw.decode("utf-8") or "{}", parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise RagCallbackTransportError("RAG callback returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise RagCallbackTransportError("RAG callback returned a non-object response")
        return value

    raise RagCallbackTransportError(
        f"RAG callback acknowledgement failed after {attempts} attempts: "
        f"{last_error.__class__.__name__ if last_error else 'unknown error'}"
    ) from last_error


def ensure_rag_callback_allows_work(
    response: dict[str, Any],
    *,
    expected_stage: str | None = None,
) -> dict[str, Any]:
    """Stop stale/superseded work even when the callback returned HTTP 200."""

    status = str(response.get("status") or "").strip().casefold()
    stage = str(response.get("stage") or "").strip().casefold()
    error = str(response.get("error") or "").strip()
    if status == "ready" or stage == "ready":
        raise RagJobAlreadyComplete("RAG job is already ready; physical retry is unnecessary")
    rejected_states = {"failed", "canceled", "cancelled", "stale", "superseded"}
    error_key = error.casefold()
    if (
        status in rejected_states
        or stage in rejected_states
        or "superseded" in error_key
        or "stale generation" in error_key
        or "no longer current" in error_key
    ):
        raise RagStageRejectedError(error or f"RAG stage was rejected with status={status or stage}")
    expected = str(expected_stage or "").strip().casefold()
    actual = stage if stage in RAG_STAGE_ORDER else status
    if expected in RAG_STAGE_ORDER and actual in RAG_STAGE_ORDER:
        if RAG_STAGE_ORDER[actual] > RAG_STAGE_ORDER[expected]:
            raise RagJobAlreadyComplete(
                f"RAG job already advanced to {actual}; {expected} physical retry is unnecessary"
            )
        if RAG_STAGE_ORDER[actual] < RAG_STAGE_ORDER[expected]:
            raise RagCallbackTransportError(
                f"RAG callback did not acknowledge stage {expected}; current stage is {actual}"
            )
    return response


def normalize_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def render_scalar(value: Any, data_type: str | None = None) -> str:
    """Render a Catalog value deterministically for title/body text."""

    if value is None:
        return ""
    kind = str(data_type or "").casefold()
    if "bool" in kind:
        if isinstance(value, bool):
            return "true" if value else "false"
        text = str(value).strip().casefold()
        if text in {"true", "false"}:
            return text
    if any(token in kind for token in ("int", "long", "short")):
        try:
            return str(int(Decimal(str(value).strip())))
        except (InvalidOperation, ValueError):
            pass
    if any(token in kind for token in ("float", "double", "decimal", "numeric", "number")):
        try:
            normalized = format(Decimal(str(value).strip()), "f")
            if "." in normalized:
                normalized = normalized.rstrip("0").rstrip(".")
            return normalized or "0"
        except (InvalidOperation, ValueError):
            pass
    if any(token in kind for token in ("date", "time", "timestamp")) and hasattr(value, "isoformat"):
        return str(value.isoformat()).strip()
    if any(token in kind for token in ("date", "time", "timestamp")) and isinstance(value, str):
        text = value.strip()
        if kind == "date" or ("date" in kind and not any(token in kind for token in ("time", "timestamp", "datetime"))):
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                pass
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
        except ValueError:
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                pass
    if isinstance(value, (dict, list, tuple)):
        return canonical_json(flatten_value(value))
    return str(value).strip()


def _field_spec(field: Any, mapping: dict[str, str], schema_types: dict[str, str]) -> tuple[str, str, str]:
    if isinstance(field, dict):
        logical = str(field.get("logicalField") or field.get("logical_field") or field.get("name") or "").strip()
        physical = str(field.get("physicalField") or field.get("physical_field") or mapping.get(logical) or logical).strip()
        data_type = str(field.get("dataType") or field.get("data_type") or schema_types.get(logical) or "").strip()
    else:
        logical = str(field).strip()
        physical = str(mapping.get(logical) or logical).strip()
        data_type = str(schema_types.get(logical) or "").strip()
    return logical, physical, data_type


def build_field_blocks(
    row: dict[str, Any],
    fields: Iterable[Any],
    *,
    logical_to_physical: dict[str, str] | None = None,
    schema_types: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Create ordered, labeled field blocks from the approved role columns."""

    mapping = logical_to_physical or {}
    types = schema_types or {}
    blocks: list[dict[str, Any]] = []
    for field in fields:
        logical, physical, data_type = _field_spec(field, mapping, types)
        if not logical:
            continue
        value = row.get(physical)
        if value is None and logical != physical:
            value = row.get(logical)
        text = render_scalar(value, data_type)
        if not text:
            continue
        blocks.append({"logicalField": logical, "physicalField": physical, "dataType": data_type, "text": text})
    return blocks


def render_field_blocks(blocks: list[dict[str, Any]], section: str) -> tuple[str, list[dict[str, Any]]]:
    """Render labeled blocks and attach canonical source offsets."""

    section_name = str(section).upper()
    parts = [f"[{section_name}]\n"]
    enriched: list[dict[str, Any]] = []
    cursor = len(parts[0])
    for index, block in enumerate(blocks):
        logical = str(block.get("logicalField") or "").strip()
        text = str(block.get("text") or "").strip()
        if not logical or not text:
            continue
        prefix = f"{logical}: "
        if index:
            parts.append("\n\n")
            cursor += 2
        block_start = cursor
        parts.append(prefix)
        cursor += len(prefix)
        value_start = cursor
        parts.append(text)
        cursor += len(text)
        value_end = cursor
        block_end = cursor
        enriched.append({**block, "start": block_start, "end": block_end, "valueStart": value_start, "valueEnd": value_end})
    if not enriched:
        return "", []
    parts.append(f"\n[/{section_name}]")
    return "".join(parts), enriched


def flatten_value(value: Any) -> Any:
    """Keep arrays atomic while making nested objects addressable.

    Arrays are intentionally compact JSON, rather than exploded rows.  Row
    identity must remain one source row per parent document.
    """

    if isinstance(value, dict):
        return {str(key): flatten_value(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if isinstance(value, (list, tuple)):
        return [flatten_value(item) for item in value]
    return normalize_scalar(value)


def normalized_row(row: dict[str, Any], schema_columns: Iterable[str]) -> dict[str, Any]:
    allowed = {str(column).strip() for column in schema_columns if str(column).strip()}
    return {column: flatten_value(row.get(column)) for column in sorted(allowed) if column in row}


def join_columns(row: dict[str, Any], columns: Iterable[str]) -> str:
    blocks = []
    for column in columns:
        logical = str(column).strip()
        value = row.get(logical)
        text = render_scalar(value)
        if logical and text:
            blocks.append({"logicalField": logical, "physicalField": logical, "text": text})
    rendered, _ = render_field_blocks(blocks, "BODY")
    return rendered


def embedding_text(title: str | None, body: str) -> str:
    title_text = str(title or "").strip()
    body_text = str(body or "").strip()
    return "\n\n".join(item for item in (title_text, body_text) if item)


def composite_source_row_id(row: dict[str, Any], identifier_columns: Iterable[str]) -> str:
    """Return the versioned ordered-composite identifier used by every data plane.

    Column order and JSON scalar types are intentionally part of the digest.
    Missing members are rejected instead of silently degrading to a partial key.
    """

    identifiers = [str(column).strip() for column in identifier_columns if str(column).strip()]
    if not identifiers:
        raise ValueError("RAG_SOURCE_IDENTIFIER_COLUMNS_REQUIRED")
    values: list[dict[str, Any]] = []
    missing: list[str] = []
    for column in identifiers:
        value = row.get(column)
        if value in (None, "") or (isinstance(value, str) and not value.strip()):
            missing.append(column)
        else:
            values.append({"column": column, "value": flatten_value(value)})
    if missing:
        raise ValueError(f"RAG_SOURCE_IDENTIFIER_MISSING: {','.join(missing)}")
    return f"identifier:{sha256_hex(values)[:32]}"


def source_row_id(row: dict[str, Any], identifier_columns: Iterable[str], ordinal: int) -> str:
    identifiers = [str(column).strip() for column in identifier_columns if str(column).strip()]
    if identifiers:
        return composite_source_row_id(row, identifiers)
    for fallback in ("id", "review_id", "row_id"):
        value = row.get(fallback)
        if value not in (None, ""):
            return str(value).strip()
    # A Spark row ordinal is not stable across repartitioning, file listing
    # order, or a retry in a new application.  Keep the argument for API
    # compatibility, but derive the fallback from canonical row content.
    # Approval requires a real identifier for production indexing; this
    # fallback is only a deterministic safety net for local/legacy callers.
    return f"rowhash:{sha256_hex(row)[:32]}"


def merge_source_field_roles(
    role_specs: Iterable[tuple[str, Iterable[Any]]],
    *,
    logical_to_physical: dict[str, str] | None = None,
    schema_types: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Merge dual-use fields while retaining the legacy singular ``role``.

    ``roles`` is the lossless provenance contract.  ``role`` remains the first
    approved role so existing OpenSearch mappings and readers remain valid.
    """

    mapping = logical_to_physical or {}
    types = schema_types or {}
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for role, specs in role_specs:
        normalized_role = str(role or "").strip().casefold()
        if not normalized_role:
            continue
        for field in specs:
            logical, physical, _ = _field_spec(field, mapping, types)
            if not logical:
                continue
            key = (logical, physical)
            current = merged.get(key)
            if current is None:
                current = {
                    "logicalField": logical,
                    "physicalField": physical,
                    "role": normalized_role,
                    "roles": [normalized_role],
                }
                merged[key] = current
            elif normalized_role not in current["roles"]:
                current["roles"].append(normalized_role)
    return list(merged.values())


def parent_document_id(dataset_id: str, source_row: str, content_hash: str) -> str:
    return sha256_hex(f"{dataset_id}\x00{source_row}\x00{content_hash}".encode("utf-8"))[:32]


def build_parent_document(
    *,
    dataset_id: str,
    source_fingerprint: str,
    row: dict[str, Any],
    schema_columns: Iterable[str],
    body_columns: Iterable[str],
    title_columns: Iterable[str],
    metadata_columns: Iterable[str],
    identifier_columns: Iterable[str],
    included_columns: Iterable[str] | None = None,
    semantic_bindings: dict[str, Any] | None = None,
    ordinal: int,
    job_id: str,
    policy_fingerprint: str,
    staged_at: str | None = None,
    body_fields: Iterable[Any] | None = None,
    title_fields: Iterable[Any] | None = None,
    metadata_fields: Iterable[Any] | None = None,
    identifier_fields: Iterable[Any] | None = None,
    logical_to_physical: dict[str, str] | None = None,
    schema_types: dict[str, str] | None = None,
) -> dict[str, Any]:
    normalized = normalized_row(row, included_columns if included_columns is not None else schema_columns)
    mapping = logical_to_physical or {}
    types = schema_types or {}
    body_specs = list(body_fields) if body_fields is not None else [{"logicalField": column, "physicalField": mapping.get(str(column), str(column)), "dataType": types.get(str(column), "")} for column in body_columns]
    title_specs = list(title_fields) if title_fields is not None else [{"logicalField": column, "physicalField": mapping.get(str(column), str(column)), "dataType": types.get(str(column), "")} for column in title_columns]
    metadata_specs = list(metadata_fields) if metadata_fields is not None else list(metadata_columns)
    identifier_specs = list(identifier_fields) if identifier_fields is not None else list(identifier_columns)
    body_blocks, title_blocks = build_field_blocks(normalized, body_specs, logical_to_physical=mapping, schema_types=types), build_field_blocks(normalized, title_specs, logical_to_physical=mapping, schema_types=types)
    body, body_blocks = render_field_blocks(body_blocks, "BODY")
    title, title_blocks = render_field_blocks(title_blocks, "TITLE")
    title = title or None
    metadata = {}
    metadata_display = {}
    for field in metadata_specs:
        logical, physical, _ = _field_spec(field, mapping, types)
        value = normalized.get(physical)
        if value is None:
            value = normalized.get(logical)
        if value is not None:
            metadata[physical] = value
            metadata_display[logical] = value
    identifier_hash_columns = [
        physical
        for field in identifier_specs
        if (physical := _field_spec(field, mapping, types)[1])
    ]
    source_id = source_row_id(normalized, identifier_hash_columns, ordinal)
    source_fields = merge_source_field_roles(
        (
            ("body", body_specs),
            ("title", title_specs),
            ("metadata", metadata_specs),
            ("identifier", identifier_specs),
        ),
        logical_to_physical=mapping,
        schema_types=types,
    )
    content_hash = sha256_hex({"title": title, "body": body, "metadata": metadata, "normalizedRow": normalized})
    parent_id = parent_document_id(dataset_id, source_id, content_hash)
    return {
        "schema_version": RAG_PARENT_SCHEMA_VERSION,
        "dataset_id": dataset_id,
        "source_fingerprint": source_fingerprint,
        "source_row_id": source_id,
        "row_ordinal": ordinal,
        "parent_document_id": parent_id,
        "title": title,
        "body": body,
        "title_blocks": title_blocks,
        "body_blocks": body_blocks,
        "metadata": metadata,
        "metadata_display": metadata_display,
        "normalized_row": normalized,
        "source_columns": list(dict.fromkeys(str(field["logicalField"]) for field in source_fields)),
        "source_fields": source_fields,
        "content_hash": content_hash,
        "embedding_input_version": EMBEDDING_INPUT_VERSION,
        "field_rendering_version": FIELD_RENDERING_VERSION,
        "policy_fingerprint": policy_fingerprint,
        "job_id": job_id,
        "semantic_bindings": semantic_bindings or {},
        "staged_at": staged_at or datetime.now(timezone.utc).isoformat(),
    }


def validate_parent_document(document: dict[str, Any]) -> None:
    required = ("schema_version", "dataset_id", "source_fingerprint", "source_row_id", "parent_document_id", "body", "content_hash")
    missing = [field for field in required if not str(document.get(field) or "").strip()]
    if missing:
        raise ValueError(f"RAG_PARENT_REQUIRED_FIELDS_MISSING: {','.join(missing)}")
    if document.get("schema_version") != RAG_PARENT_SCHEMA_VERSION:
        raise ValueError("RAG_PARENT_SCHEMA_VERSION_UNSUPPORTED")
    if not isinstance(document.get("metadata"), dict) or not isinstance(document.get("normalized_row"), dict):
        raise ValueError("RAG_PARENT_OBJECT_FIELDS_INVALID")


def build_staging_paths(*, base_path: str, dataset_id: str, job_id: str) -> dict[str, str]:
    root = f"{base_path.rstrip('/')}/rag/parents/dataset_id={dataset_id}"
    return {
        "table": root,
        "checkpoint": f"{base_path.rstrip('/')}/rag/checkpoints/parents/dataset_id={dataset_id}/job_id={job_id}",
        "report": f"{base_path.rstrip('/')}/rag/reports/parents/{job_id}.json",
    }


def failed_row_report(*, row_count: int, failed_count: int, threshold: float, quarantined_table: str) -> dict[str, Any]:
    """Build the persisted row-quality contract used by every staging path."""

    total = max(0, int(row_count))
    failed = min(total, max(0, int(failed_count)))
    return {
        "rowCount": total,
        "validCount": total - failed,
        "failedCount": failed,
        "failedRate": failed / total if total else 0.0,
        "threshold": float(threshold),
        "quarantinedTable": str(quarantined_table),
    }
