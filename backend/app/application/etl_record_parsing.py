"""Record parsing preview policy used by the ETL compatibility facade."""

from datetime import datetime
import re

from fastapi import status

from app.application.etl_job_projection import normalize_column_name
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    RecordParsingColumnDraft,
    RecordParsingInvalidRow,
    RecordParsingPreviewRequest,
    RecordParsingPreviewResponse,
    SchemaColumnDraft,
)


def preview_record_parsing(request: RecordParsingPreviewRequest) -> RecordParsingPreviewResponse:
    raw_rows = [
        (line_number, line.strip())
        for line_number, line in enumerate(request.raw_lines, start=1)
        if line.strip()
    ]
    if request.record_parsing.delimiter_kind != "whitespace":
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Only whitespace record parsing is supported.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not raw_rows:
        empty_parsing = request.record_parsing.model_copy(update={"expected_field_count": 0, "columns": []})
        return RecordParsingPreviewResponse(
            can_apply=False,
            columns=[],
            sample_rows=[],
            record_parsing=empty_parsing,
            total_rows=0,
            valid_rows=0,
            invalid_rows=[],
        )

    tokenized_rows = [(line_number, re.split(r"\s+", line), line) for line_number, line in raw_rows]
    header_tokens: list[str] = []
    if request.record_parsing.header and tokenized_rows:
        _, header_tokens, _ = tokenized_rows.pop(0)

    configured_columns = sorted(request.record_parsing.columns, key=lambda column: column.position)
    expected_field_count = request.record_parsing.expected_field_count
    if expected_field_count == 0 and configured_columns:
        expected_field_count = len(configured_columns)
    if expected_field_count == 0:
        expected_field_count = dominant_field_count([tokens for _, tokens, _ in tokenized_rows])

    column_names = record_parsing_column_names(header_tokens, configured_columns, expected_field_count)
    valid_token_rows = [tokens for _, tokens, _ in tokenized_rows if len(tokens) == expected_field_count]
    invalid_records = [
        RecordParsingInvalidRow(
            line_number=line_number,
            expected_field_count=expected_field_count,
            actual_field_count=len(tokens),
            raw_preview=raw_line[:200],
        )
        for line_number, tokens, raw_line in tokenized_rows
        if len(tokens) != expected_field_count
    ]
    inferred_types = [
        infer_record_parsing_type([row[index] for row in valid_token_rows if index < len(row)])
        for index in range(expected_field_count)
    ]
    record_columns = [
        RecordParsingColumnDraft(
            position=index,
            name=column_names[index],
            inferred_type=(configured_columns[index].inferred_type if index < len(configured_columns) else inferred_types[index]),
        )
        for index in range(expected_field_count)
    ]
    schema_columns = [
        SchemaColumnDraft(
            confidence=90,
            nullable=False,
            source_name=column.name,
            target_name=column.name,
            type=column.inferred_type,
        )
        for column in record_columns
    ]
    unique_names = len(set(column_names)) == len(column_names) and all(column_names)
    normalized = request.record_parsing.model_copy(update={
        "enabled": True,
        "expected_field_count": expected_field_count,
        "columns": record_columns,
    })
    return RecordParsingPreviewResponse(
        can_apply=bool(expected_field_count and tokenized_rows and not invalid_records and unique_names),
        columns=schema_columns,
        sample_rows=valid_token_rows[:100],
        record_parsing=normalized,
        total_rows=len(tokenized_rows),
        valid_rows=len(valid_token_rows),
        invalid_rows=invalid_records[:20],
    )


def dominant_field_count(rows: list[list[str]]) -> int:
    counts: dict[int, int] = {}
    for row in rows:
        counts[len(row)] = counts.get(len(row), 0) + 1
    if not counts:
        return 0
    highest = max(counts.values())
    winners = [field_count for field_count, count in counts.items() if count == highest]
    return winners[0] if len(winners) == 1 else 0


def record_parsing_column_names(
    header_tokens: list[str],
    configured_columns: list[RecordParsingColumnDraft],
    expected_field_count: int,
) -> list[str]:
    names: list[str] = []
    for index in range(expected_field_count):
        raw_name = (
            configured_columns[index].name
            if index < len(configured_columns)
            else header_tokens[index] if index < len(header_tokens) else f"field_{index + 1}"
        )
        names.append(normalize_column_name(raw_name) or f"field_{index + 1}")
    return names


def infer_record_parsing_type(values: list[str]) -> str:
    non_empty = [value.strip() for value in values if value.strip()]
    if not non_empty:
        return "String"
    if all(re.fullmatch(r"-?\d+", value) for value in non_empty):
        return "Integer"
    if all(re.fullmatch(r"-?\d+(?:\.\d+)?", value) for value in non_empty):
        return "Float"
    if all(value.lower() in {"true", "false"} for value in non_empty):
        return "Boolean"
    if all(record_parsing_timestamp(value) for value in non_empty):
        return "Timestamp"
    return "String"


def record_parsing_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return "T" in value or ":" in value
    except ValueError:
        return False
