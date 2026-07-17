import json

from app.repositories.sql_repository import SqlRepository
from app.schemas.trino import TrinoQueryRunResponse


def with_trino_preview_limit(compiled_query: str, limit: int = 100) -> str:
    statement = compiled_query.strip().rstrip(";").strip()
    bounded_limit = max(1, min(int(limit), 100))
    return f'SELECT * FROM ({statement}) AS "_asklake_preview" LIMIT {bounded_limit}'


def execution_query_for_mode(compiled_query: str, mode: str, preview_limit: int) -> str:
    if mode != "preview":
        return compiled_query
    return with_trino_preview_limit(compiled_query, preview_limit)


def save_inline_preview_page(
    repository: SqlRepository,
    response: TrinoQueryRunResponse,
    *,
    page_count: int,
    columns: list[str],
    rows: list[list[object]],
    source_next_uri: str | None,
    worker_id: str | None,
    generation: int | None,
) -> str:
    byte_size = len(json.dumps(
        {"columns": columns, "rows": rows},
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8"))
    if worker_id is not None and generation is not None and source_next_uri:
        return repository.save_result_page_if_owned(
            run_id=response.run_id,
            worker_id=worker_id,
            generation=generation,
            page_index=page_count,
            columns=columns,
            rows=rows,
            byte_size=byte_size,
            source_next_uri=source_next_uri,
        )
    repository.save_result_page(
        run_id=response.run_id,
        page_index=page_count,
        columns=columns,
        rows=rows,
        byte_size=byte_size,
        source_next_uri=source_next_uri,
    )
    return "saved"
