import json
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings


DEFAULT_SAMPLE_ROW_LIMIT = 20


@dataclass(frozen=True)
class MaterializedDatasetResult:
    sample_rows: list[list[str]]
    storage_format: str
    storage_location: str
    storage_size_bytes: int
    row_count: int


class LocalLakeStorageService:
    def __init__(self, storage_root: str | None = None) -> None:
        self.storage_root = Path(storage_root or default_storage_root())

    def materialize_sql_result(
        self,
        *,
        columns: list[str],
        dataset_id: str,
        layer: str,
        rows: list[list[str]],
        source_run_id: str,
    ) -> MaterializedDatasetResult:
        dataset_dir = self.storage_root / "sql-derived" / layer.lower() / dataset_id / source_run_id
        dataset_dir.mkdir(parents=True, exist_ok=True)

        data_path = dataset_dir / "data.jsonl"
        metadata_path = dataset_dir / "metadata.json"
        normalized_rows = normalize_rows(rows, len(columns))

        with data_path.open("w", encoding="utf-8") as data_file:
            for row in normalized_rows:
                data_file.write(
                    json.dumps(row_to_record(columns, row), ensure_ascii=False)
                )
                data_file.write("\n")

        metadata = {
            "columns": columns,
            "datasetId": dataset_id,
            "format": "jsonl",
            "rowCount": len(normalized_rows),
            "sourceRunId": source_run_id,
            "storageLocation": str(data_path),
        }
        metadata_path.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return MaterializedDatasetResult(
            sample_rows=normalized_rows[:DEFAULT_SAMPLE_ROW_LIMIT],
            storage_format="jsonl",
            storage_location=str(data_path),
            storage_size_bytes=data_path.stat().st_size,
            row_count=len(normalized_rows),
        )


def default_storage_root() -> Path:
    if settings.local_lake_storage_dir:
        return Path(settings.local_lake_storage_dir)
    return Path(__file__).resolve().parents[2] / "tmp" / "spark-output"


def normalize_rows(rows: list[list[str]], column_count: int) -> list[list[str]]:
    normalized_rows: list[list[str]] = []
    for row in rows:
        normalized_rows.append([
            str(row[index]) if index < len(row) else ""
            for index in range(column_count)
        ])
    return normalized_rows


def row_to_record(columns: list[str], row: list[str]) -> dict[str, str]:
    record: dict[str, str] = {}
    for index, column_name in enumerate(columns):
        key = column_name or f"column_{index + 1}"
        if key in record:
            key = f"{key}_{index + 1}"
        record[key] = row[index] if index < len(row) else ""
    return record
