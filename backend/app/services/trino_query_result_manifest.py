from datetime import datetime, timezone

from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoQueryRunResponse, TrinoQueryRunResult


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_utc_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def elapsed_milliseconds(started_at: str | None, ended_at: str | None) -> int | None:
    started = parse_utc_timestamp(started_at)
    ended = parse_utc_timestamp(ended_at)
    if started is None or ended is None:
        return None
    return max(0, round((ended - started).total_seconds() * 1000))


def with_result_collection_timing(
    response: TrinoQueryRunResponse,
    *,
    at: str | None = None,
    collection_completed: bool = False,
    first_page_available: bool = False,
) -> TrinoQueryRunResponse:
    observed_at = at or current_utc_timestamp()
    result = response.result or TrinoQueryRunResult()
    collection_started_at = result.collection_started_at or observed_at
    first_page_available_at = result.first_page_available_at
    if first_page_available and first_page_available_at is None:
        first_page_available_at = observed_at
    collection_completed_at = result.collection_completed_at
    if collection_completed and collection_completed_at is None:
        collection_completed_at = observed_at
    collection_end = collection_completed_at or observed_at
    return response.model_copy(update={
        "result": result.model_copy(update={
            "collection_completed_at": collection_completed_at,
            "collection_elapsed_ms": elapsed_milliseconds(collection_started_at, collection_end),
            "collection_started_at": collection_started_at,
            "first_page_available_at": first_page_available_at,
            "first_page_elapsed_ms": elapsed_milliseconds(response.submitted_at, first_page_available_at),
            "total_ready_ms": elapsed_milliseconds(response.submitted_at, collection_completed_at),
        }),
    })


def result_collection_progress_percentage(
    collected_rows: int | None,
    expected_rows: int | None,
    *,
    storage_status: str,
) -> float | None:
    if storage_status == "available":
        return 100.0
    if collected_rows is None or expected_rows is None or expected_rows <= 0:
        return None
    return max(0.0, min(100.0, (collected_rows / expected_rows) * 100))


def build_result_manifest(
    repository: SqlRepository,
    response: TrinoQueryRunResponse,
    columns: list[str],
    *,
    next_uri: str | None,
) -> TrinoQueryRunResponse:
    page_count = repository.count_result_pages(response.run_id)
    response = with_result_collection_timing(response, first_page_available=page_count > 0)
    result = response.result or TrinoQueryRunResult()
    total_bytes = repository.total_result_bytes(response.run_id)
    collected_rows = repository.total_result_rows(response.run_id)
    expected_rows = response.stats.output_rows if response.stats else None
    storage_status = "available" if response.status == "succeeded" and not next_uri else "collecting"
    return response.model_copy(update={
        "result": result.model_copy(update={
            "available_page_count": page_count,
            "byte_size": total_bytes,
            "collected_row_count": collected_rows,
            "collection_progress_percentage": result_collection_progress_percentage(
                collected_rows,
                expected_rows,
                storage_status=storage_status,
            ),
            "columns": columns or result.columns,
            "expected_row_count": expected_rows,
            "page_count": page_count,
            "row_count": collected_rows,
            "storage": "postgres" if response.mode == "preview" else "s3",
            "storage_status": storage_status,
        }),
    })
