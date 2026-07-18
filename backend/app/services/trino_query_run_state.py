"""Pure Query Run state, statistics, fingerprint, and cursor helpers.

This module has no repository or object-storage ownership.  It keeps the
canonical value transformations reusable by submission, collection, and
result-reading services without making those services depend on each other.
"""

import base64
import binascii
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
from typing import Iterable
from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.trino import (
    SubmitTrinoQueryRunRequest,
    TrinoClientPage,
    TrinoQueryEstimate,
    TrinoQueryRunEstimate,
    TrinoQueryRunHistoryItem,
    TrinoQueryRunHistoryResult,
    TrinoQueryRunHistoryStats,
    TrinoQueryRunResponse,
    TrinoQueryRunResult,
    TrinoQueryRunStats,
)
from app.services.trino_client import TrinoQueryInfo
from app.services.trino_query_result_manifest import current_utc_timestamp


def to_history_item(response: TrinoQueryRunResponse) -> TrinoQueryRunHistoryItem:
    result = response.result
    return TrinoQueryRunHistoryItem(
        base_dataset_id=response.base_dataset_id,
        completed_at=response.completed_at,
        query=response.query,
        result=TrinoQueryRunHistoryResult(
            row_count=result.row_count,
            storage_status=result.storage_status,
        ) if result else None,
        run_id=response.run_id,
        stats=TrinoQueryRunHistoryStats(processed_bytes=response.stats.processed_bytes) if response.stats else None,
        status=response.status,
        submitted_at=response.submitted_at,
    )


def build_run_response(
    request: SubmitTrinoQueryRunRequest,
    page: TrinoClientPage,
    actor: ActorContext,
    retention_seconds: int,
    *,
    estimate: TrinoQueryRunEstimate | None = None,
    run_id: str | None = None,
    submitted_at: str | None = None,
) -> TrinoQueryRunResponse:
    submitted_at = submitted_at or current_utc_timestamp()
    collection_started_at = current_utc_timestamp()
    response = TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        estimate=estimate,
        error=page.error,
        mode=request.mode,
        query=request.query,
        reference_dataset_ids=unique_values(request.reference_dataset_ids),
        result=TrinoQueryRunResult(
            collection_started_at=collection_started_at,
            columns=page.columns,
            retention_expires_at=(datetime.now(timezone.utc) + timedelta(seconds=retention_seconds)).isoformat(),
            storage_status="collecting",
        ),
        run_id=run_id or f"trino_{uuid4().hex[:12]}",
        stats=trino_stats(page.raw_stats),
        status=trino_status(page),
        submitted_at=submitted_at,
        submitted_by_name=actor.name,
        submitted_by_user_id=actor.id,
        source_run_id=request.source_run_id,
        trino_query_id=page.query_id or None,
    )
    return apply_terminal_timestamps(response)


def build_reserved_run_response(
    request: SubmitTrinoQueryRunRequest,
    actor: ActorContext,
    retention_seconds: int,
    *,
    estimate: TrinoQueryRunEstimate | None = None,
) -> TrinoQueryRunResponse:
    return TrinoQueryRunResponse(
        base_dataset_id=request.base_dataset_id,
        estimate=estimate,
        mode=request.mode,
        query=request.query,
        reference_dataset_ids=unique_values(request.reference_dataset_ids),
        result=TrinoQueryRunResult(
            retention_expires_at=(datetime.now(timezone.utc) + timedelta(seconds=retention_seconds)).isoformat(),
            storage_status="collecting",
        ),
        run_id=f"trino_{uuid4().hex[:12]}",
        status="queued",
        submitted_at=current_utc_timestamp(),
        submitted_by_name=actor.name,
        submitted_by_user_id=actor.id,
        source_run_id=request.source_run_id,
    )


def apply_trino_page(response: TrinoQueryRunResponse, page: TrinoClientPage) -> TrinoQueryRunResponse:
    result = response.result or TrinoQueryRunResult()
    if page.columns:
        result = result.model_copy(update={"columns": page.columns})
    page_stats = trino_stats(page.raw_stats)
    updated = response.model_copy(update={
        "error": page.error,
        "result": result,
        "stats": merge_trino_run_stats(response.stats, page_stats),
        "status": trino_status(page),
        "trino_query_id": page.query_id or response.trino_query_id,
    })
    return apply_terminal_timestamps(updated)


def apply_terminal_timestamps(response: TrinoQueryRunResponse) -> TrinoQueryRunResponse:
    updates: dict[str, str] = {}
    if response.status == "running" and response.started_at is None:
        updates["started_at"] = current_utc_timestamp()
    if response.status in {"succeeded", "failed", "cancelled"} and response.completed_at is None:
        updates["completed_at"] = current_utc_timestamp()
    updated = response.model_copy(update=updates) if updates else response
    if updated.status == "succeeded" and (updated.stats is None or updated.stats.query_completed_at is None):
        completed_at = updated.completed_at or current_utc_timestamp()
        stats = updated.stats or TrinoQueryRunStats()
        updated = updated.model_copy(update={
            "stats": stats.model_copy(update={"query_completed_at": completed_at}),
        })
    return updated


def trino_status(page: TrinoClientPage) -> str:
    if page.error is not None:
        return "failed"
    state = (page.state or "").upper()
    if state == "FINISHED" and not page.next_uri:
        return "succeeded"
    if state in {"CANCELED", "CANCELLED"}:
        return "cancelled"
    if state in {"QUEUED", "PLANNING", "STARTING"}:
        return "queued"
    return "running"


def trino_stats(raw_stats: dict[str, object]) -> TrinoQueryRunStats | None:
    if not raw_stats:
        return None
    query_state = str(raw_stats.get("state") or "").strip().upper() or None
    completed_splits = int_or_none(raw_stats.get("completedSplits"))
    total_splits = int_or_none(raw_stats.get("totalSplits"))
    progress_percentage = float_or_none(raw_stats.get("progressPercentage"))
    if progress_percentage is None and completed_splits is not None and total_splits and total_splits > 0:
        progress_percentage = (completed_splits / total_splits) * 100
    if progress_percentage is None and str(raw_stats.get("state") or "").upper() == "FINISHED":
        progress_percentage = 100.0
    if progress_percentage is not None:
        progress_percentage = max(0.0, min(100.0, progress_percentage))
    return TrinoQueryRunStats(
        cpu_ms=int_or_none(raw_stats.get("cpuTimeMillis")),
        completed_splits=completed_splits,
        elapsed_ms=int_or_none(raw_stats.get("elapsedTimeMillis")),
        peak_memory_bytes=int_or_none(raw_stats.get("peakMemoryBytes")),
        progress_percentage=progress_percentage,
        progress_observed_at=current_utc_timestamp(),
        processed_bytes=int_or_none(raw_stats.get("processedBytes")),
        processed_rows=int_or_none(raw_stats.get("processedRows")),
        query_completed_at=current_utc_timestamp() if query_state in {"FINISHING", "FINISHED"} else None,
        query_state=query_state,
        queued_ms=int_or_none(raw_stats.get("queuedTimeMillis")),
        total_splits=total_splits,
    )


def merge_trino_run_stats(
    current: TrinoQueryRunStats | None,
    incoming: TrinoQueryRunStats | None,
) -> TrinoQueryRunStats | None:
    if current is None:
        return incoming
    if incoming is None:
        return current
    monotonic_fields = {
        "completed_drivers",
        "completed_splits",
        "cpu_ms",
        "elapsed_ms",
        "output_bytes",
        "output_rows",
        "peak_memory_bytes",
        "processed_bytes",
        "processed_rows",
        "progress_percentage",
        "queued_ms",
        "total_drivers",
        "total_splits",
    }
    updates: dict[str, object] = {}
    for field_name in TrinoQueryRunStats.model_fields:
        incoming_value = getattr(incoming, field_name)
        if incoming_value is None or field_name == "progress_observed_at":
            continue
        current_value = getattr(current, field_name)
        if field_name in monotonic_fields:
            merged_value = max_observed(current_value, incoming_value)
        elif field_name == "query_completed_at":
            merged_value = current_value or incoming_value
        elif field_name == "query_state":
            merged_value = merge_trino_query_state(current_value, incoming_value)
        else:
            merged_value = incoming_value
        if merged_value != current_value:
            updates[field_name] = merged_value
    if updates and incoming.progress_observed_at is not None:
        updates["progress_observed_at"] = incoming.progress_observed_at
    return current.model_copy(update=updates) if updates else current


def apply_trino_query_info(
    response: TrinoQueryRunResponse,
    query_info: TrinoQueryInfo,
) -> TrinoQueryRunResponse:
    raw_stats = query_info.raw_stats
    query_state = str(query_info.state or raw_stats.get("state") or "").strip().upper() or None
    completed_drivers = int_or_none(raw_stats.get("completedDrivers"))
    total_drivers = int_or_none(raw_stats.get("totalDrivers"))
    progress_percentage = float_or_none(raw_stats.get("progressPercentage"))
    if progress_percentage is None and completed_drivers is not None and total_drivers and total_drivers > 0:
        progress_percentage = (completed_drivers / total_drivers) * 100
    if progress_percentage is None and query_state == "FINISHED":
        progress_percentage = 100.0
    if progress_percentage is not None:
        progress_percentage = max(0.0, min(100.0, progress_percentage))

    current = response.stats or TrinoQueryRunStats()
    query_state = merge_trino_query_state(current.query_state, query_state)
    elapsed_ms = first_not_none(
        int_or_none(raw_stats.get("elapsedTimeMillis")),
        parse_trino_duration_ms(raw_stats.get("elapsedTime")),
    )
    queued_ms = first_not_none(
        int_or_none(raw_stats.get("queuedTimeMillis")),
        parse_trino_duration_ms(raw_stats.get("queuedTime")),
    )
    cpu_ms = first_not_none(
        int_or_none(raw_stats.get("cpuTimeMillis")),
        parse_trino_duration_ms(raw_stats.get("totalCpuTime")),
    )
    processed_bytes = first_not_none(
        int_or_none(raw_stats.get("processedBytes")),
        parse_trino_data_size_bytes(raw_stats.get("processedInputDataSize")),
        parse_trino_data_size_bytes(raw_stats.get("physicalInputDataSize")),
        parse_trino_data_size_bytes(raw_stats.get("rawInputDataSize")),
    )
    processed_rows = first_not_none(
        int_or_none(raw_stats.get("processedRows")),
        int_or_none(raw_stats.get("processedInputPositions")),
        int_or_none(raw_stats.get("physicalInputPositions")),
        int_or_none(raw_stats.get("rawInputPositions")),
    )
    peak_memory_bytes = first_not_none(
        int_or_none(raw_stats.get("peakMemoryBytes")),
        parse_trino_data_size_bytes(raw_stats.get("peakUserMemoryReservation")),
        parse_trino_data_size_bytes(raw_stats.get("peakTotalMemoryReservation")),
    )
    candidate_updates: dict[str, object] = {
        "completed_drivers": max_observed(current.completed_drivers, completed_drivers),
        "cpu_ms": max_observed(current.cpu_ms, cpu_ms),
        "elapsed_ms": max_observed(current.elapsed_ms, elapsed_ms),
        "peak_memory_bytes": max_observed(current.peak_memory_bytes, peak_memory_bytes),
        "processed_bytes": max_observed(current.processed_bytes, processed_bytes),
        "processed_rows": max_observed(current.processed_rows, processed_rows),
        "progress_percentage": max_observed(current.progress_percentage, progress_percentage),
        "query_state": query_state,
        "queued_ms": max_observed(current.queued_ms, queued_ms),
        "total_drivers": max_observed(current.total_drivers, total_drivers),
    }
    output_is_final = query_state in {"FINISHING", "FINISHED"} or candidate_updates["progress_percentage"] == 100
    if output_is_final:
        candidate_updates.update({
            "output_bytes": max_observed(
                current.output_bytes,
                parse_trino_data_size_bytes(raw_stats.get("outputDataSize")),
            ),
            "output_rows": max_observed(current.output_rows, int_or_none(raw_stats.get("outputPositions"))),
        })
        if current.query_completed_at is None:
            candidate_updates["query_completed_at"] = current_utc_timestamp()

    changed_updates = {
        field_name: value
        for field_name, value in candidate_updates.items()
        if value is not None and getattr(current, field_name) != value
    }
    if not changed_updates:
        return response
    changed_updates["progress_observed_at"] = current_utc_timestamp()
    return response.model_copy(update={"stats": current.model_copy(update=changed_updates)})


_TRINO_DATA_SIZE_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB)\s*$", re.IGNORECASE)
_TRINO_DATA_SIZE_FACTORS = {
    "B": 1,
    "KB": 1024,
    "MB": 1024**2,
    "GB": 1024**3,
    "TB": 1024**4,
    "PB": 1024**5,
}

_TRINO_DURATION_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|m|h|d)\s*$", re.IGNORECASE)
_TRINO_DURATION_MILLISECOND_FACTORS = {
    "NS": 0.000001,
    "US": 0.001,
    "ΜS": 0.001,
    "MS": 1,
    "S": 1_000,
    "M": 60_000,
    "H": 3_600_000,
    "D": 86_400_000,
}


def parse_trino_data_size_bytes(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    match = _TRINO_DATA_SIZE_PATTERN.fullmatch(str(value))
    if match is None:
        return None
    amount = float(match.group(1))
    return max(0, int(amount * _TRINO_DATA_SIZE_FACTORS[match.group(2).upper()]))


def parse_trino_duration_ms(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, round(float(value)))
    match = _TRINO_DURATION_PATTERN.fullmatch(str(value))
    if match is None:
        return None
    amount = float(match.group(1))
    unit = match.group(2).upper().replace("µ", "Μ")
    return max(0, round(amount * _TRINO_DURATION_MILLISECOND_FACTORS[unit]))


def first_not_none(*values: int | None) -> int | None:
    return next((value for value in values if value is not None), None)


def max_observed(current: int | float | None, incoming: int | float | None) -> int | float | None:
    if current is None:
        return incoming
    if incoming is None:
        return current
    return max(current, incoming)


def merge_trino_query_state(current: str | None, incoming: str | None) -> str | None:
    current_state = str(current or "").strip().upper() or None
    incoming_state = str(incoming or "").strip().upper() or None
    if current_state in {"FINISHED", "FAILED", "CANCELED", "CANCELLED"}:
        return current_state
    if current_state == "FINISHING" and incoming_state not in {
        "FINISHED",
        "FAILED",
        "CANCELED",
        "CANCELLED",
    }:
        return current_state
    return incoming_state or current_state


def int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def float_or_none(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def query_run_estimate_snapshot(estimate: TrinoQueryEstimate) -> TrinoQueryRunEstimate:
    return TrinoQueryRunEstimate(
        duration_estimate_source=estimate.duration_estimate_source,
        estimated_bytes=estimate.estimated_bytes,
        estimated_duration_seconds=estimate.estimated_duration_seconds,
        estimated_throughput_bytes_per_second=estimate.estimated_throughput_bytes_per_second,
        estimate_source=estimate.estimate_source,
        iceberg_estimated_bytes=estimate.iceberg_estimated_bytes,
        known_input_bytes=estimate.known_input_bytes,
        plan_estimated_bytes=estimate.plan_estimated_bytes,
        risk_level=estimate.risk_level,
        warnings=estimate.warnings,
    )


def query_audit_metadata(query: str) -> dict[str, object]:
    normalized = " ".join(query.split())
    return {
        "queryHash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        "queryLength": len(query),
    }


def unique_values(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value).strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def is_run_submitter(
    submitted_by_user_id: str | None,
    submitted_by_name: str | None,
    actor: ActorContext,
) -> bool:
    if submitted_by_user_id:
        return bool(actor.id and actor.id == submitted_by_user_id)
    return bool(submitted_by_name and actor.name == submitted_by_name)


def trino_request_fingerprint(request: SubmitTrinoQueryRunRequest) -> str:
    canonical = json.dumps({
        "baseDatasetId": request.base_dataset_id,
        "mode": request.mode,
        "previewLimit": request.preview_limit if request.mode == "preview" else None,
        "query": request.query.replace("\r\n", "\n").strip(),
        "referenceDatasetIds": sorted(unique_values(request.reference_dataset_ids)),
        "resultPageSize": normalized_result_page_size(request.result_page_size),
        "sourceRunId": request.source_run_id,
    }, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalized_result_page_size(value: object) -> int:
    try:
        page_size = int(value or 100)
    except (TypeError, ValueError):
        page_size = 100
    return max(1, min(page_size, 1_000))


def decode_cursor(
    cursor: str | None,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
) -> int:
    return decode_cursor_position(
        cursor,
        run_id=run_id,
        retention_expires_at=retention_expires_at,
        secret=secret,
    )[0]


def decode_cursor_position(
    cursor: str | None,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
) -> tuple[int, int, int]:
    if cursor is None:
        return 0, 0, 0
    try:
        payload_encoded, signature = cursor.split(".", maxsplit=1)
        expected_signature = sign_cursor(payload_encoded, secret)
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError("invalid signature")
        payload = json.loads(base64.urlsafe_b64decode(pad_base64(payload_encoded)).decode("utf-8"))
        page_index = int(payload["pageIndex"])
        row_offset = int(payload.get("rowOffset") or 0)
        logical_page_index = int(payload.get("logicalPageIndex") or 0)
        expires_at = str(payload["expiresAt"])
    except (AttributeError, KeyError, TypeError, ValueError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError) as exc:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
    if payload.get("version") != 1 or payload.get("runId") != run_id or page_index < 0 or row_offset < 0 or logical_page_index < 0:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if not retention_expires_at or expires_at != retention_expires_at:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Query result cursor does not match this run", status.HTTP_422_UNPROCESSABLE_ENTITY)
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Invalid query result cursor", status.HTTP_422_UNPROCESSABLE_ENTITY) from exc
    if expiry <= datetime.now(timezone.utc):
        raise ApiError(ErrorCode.RESULT_EXPIRED, "Query result cursor has expired", status.HTTP_410_GONE)
    return page_index, row_offset, logical_page_index


def encode_cursor(
    page_index: int,
    *,
    run_id: str,
    retention_expires_at: str | None,
    secret: str,
    row_offset: int = 0,
    logical_page_index: int = 0,
) -> str:
    if page_index < 0 or row_offset < 0 or logical_page_index < 0 or not retention_expires_at:
        raise ApiError(ErrorCode.RESULT_EXPIRED, "Query result is unavailable", status.HTTP_410_GONE)
    payload = json.dumps({
        "expiresAt": retention_expires_at,
        "pageIndex": page_index,
        "logicalPageIndex": logical_page_index,
        "rowOffset": row_offset,
        "runId": run_id,
        "version": 1,
    }, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"{payload_encoded}.{sign_cursor(payload_encoded, secret)}"


def sign_cursor(payload_encoded: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload_encoded.encode("ascii"), hashlib.sha256).hexdigest()


def pad_base64(value: str) -> str:
    return value + "=" * (-len(value) % 4)
