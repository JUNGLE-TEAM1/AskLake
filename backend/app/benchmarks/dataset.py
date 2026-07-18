from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.trino_client import TrinoClient


class BenchmarkTableManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    role: Literal["fact", "dimension"]
    row_count: int = Field(gt=0, le=100_000_000)
    partition_spec: list[str] = Field(default_factory=list)
    primary_key: list[str] = Field(min_length=1)
    column_statistics: dict[str, dict[str, int | float | str]] = Field(default_factory=dict)


class BenchmarkDatasetManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fixture_id: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    fixture_version: str
    generator_version: str
    seed: int = Field(ge=0)
    catalog: str = "iceberg"
    schema_name: str = Field(alias="schema", pattern=r"^[a-z][a-z0-9_]*$")
    scale: int = Field(gt=0, le=100)
    tables: list[BenchmarkTableManifest] = Field(min_length=1)
    snapshot_policy: Literal["capture-after-load-and-pin"]
    runtime_profile: str

    @model_validator(mode="after")
    def unique_tables(self) -> "BenchmarkDatasetManifest":
        names = [table.name for table in self.tables]
        if len(names) != len(set(names)):
            raise ValueError("benchmark table names must be unique")
        if not any(table.role == "fact" for table in self.tables):
            raise ValueError("benchmark fixture requires at least one fact table")
        required = {"customers_v1", "products_v1", "orders_v1"}
        if set(names) != required:
            raise ValueError(f"generator trino-ctas-v1 requires tables: {sorted(required)}")
        if next(table for table in self.tables if table.name == "orders_v1").row_count % 1000:
            raise ValueError("orders_v1 row_count must be divisible by 1000")
        return self

    def canonical_hash(self) -> str:
        payload = self.model_dump(by_alias=True, mode="json")
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_dataset_manifest(path: Path) -> BenchmarkDatasetManifest:
    return BenchmarkDatasetManifest.model_validate_json(path.read_text(encoding="utf-8"))


def render_dataset_sql(manifest: BenchmarkDatasetManifest, *, replace: bool = False) -> list[str]:
    catalog = manifest.catalog
    schema = manifest.schema_name
    prefix = f'"{catalog}"."{schema}"'
    statements = [f'CREATE SCHEMA IF NOT EXISTS {prefix}']
    if replace:
        statements.extend(
            f'DROP TABLE IF EXISTS {prefix}."{table.name}"'
            for table in reversed(manifest.tables)
        )

    counts = {table.name: table.row_count for table in manifest.tables}
    seed = manifest.seed
    statements.extend([
        f'''CREATE TABLE {prefix}."customers_v1" WITH (format = 'PARQUET') AS
SELECT
  CAST(i AS BIGINT) AS customer_id,
  CONCAT('segment_', CAST(mod(i + {seed}, 8) AS VARCHAR)) AS segment,
  CONCAT('region_', CAST(mod(i + {seed}, 16) AS VARCHAR)) AS region,
  date_add('day', mod(i + {seed}, 365), DATE '2023-01-01') AS signup_date
FROM UNNEST(sequence(1, {counts['customers_v1']})) AS t(i)''',
        f'''CREATE TABLE {prefix}."products_v1" WITH (format = 'PARQUET') AS
SELECT
  CAST(i AS BIGINT) AS product_id,
  CONCAT('category_', CAST(mod(i + {seed}, 24) AS VARCHAR)) AS category,
  CAST(5 + mod(i * 37 + {seed}, 50000) / 100.0 AS DECIMAL(12, 2)) AS list_price
FROM UNNEST(sequence(1, {counts['products_v1']})) AS t(i)''',
        f'''CREATE TABLE {prefix}."orders_v1"
WITH (format = 'PARQUET', partitioning = ARRAY['month(order_date)']) AS
SELECT
  CAST((a - 1) * 1000 + b AS BIGINT) AS order_id,
  CAST(1 + mod((a - 1) * 1000 + b + {seed}, {counts['customers_v1']}) AS BIGINT) AS customer_id,
  CAST(1 + mod(((a - 1) * 1000 + b) * 17 + {seed}, {counts['products_v1']}) AS BIGINT) AS product_id,
  date_add('day', mod((a - 1) * 1000 + b + {seed}, 730), DATE '2024-01-01') AS order_date,
  CAST(1 + mod((a - 1) * 1000 + b + {seed}, 8) AS INTEGER) AS quantity,
  CAST(10 + mod(((a - 1) * 1000 + b) * 97 + {seed}, 200000) / 100.0 AS DECIMAL(14, 2)) AS amount,
  CONCAT('status_', CAST(mod((a - 1) * 1000 + b + {seed}, 5) AS VARCHAR)) AS status
FROM UNNEST(sequence(1, {counts['orders_v1'] // 1000})) AS x(a)
CROSS JOIN UNNEST(sequence(1, 1000)) AS y(b)''',
    ])
    return statements


def render_cleanup_sql(manifest: BenchmarkDatasetManifest) -> list[str]:
    """Render cleanup limited to the schema and tables declared by the fixture."""
    prefix = f'"{manifest.catalog}"."{manifest.schema_name}"'
    statements = [
        f'DROP TABLE IF EXISTS {prefix}."{table.name}"'
        for table in reversed(manifest.tables)
    ]
    statements.append(f'DROP SCHEMA IF EXISTS {prefix}')
    return statements


def execute_statement(client: TrinoClient, sql: str) -> tuple[list[str], list[list[Any]], dict[str, Any]]:
    page = client.submit(sql)
    columns = list(page.columns)
    rows = list(page.rows)
    stats = dict(page.raw_stats)
    for _ in range(10_000):
        if page.error:
            raise RuntimeError(f"Trino query failed [{page.error.code}]: {page.error.message}")
        if not page.next_uri:
            return columns, rows, stats
        page = client.fetch(page.next_uri)
        if page.columns:
            columns = list(page.columns)
        rows.extend(page.rows)
        stats.update(page.raw_stats)
    raise RuntimeError("Trino statement exceeded the benchmark page limit")


def load_dataset(
    manifest: BenchmarkDatasetManifest,
    client: TrinoClient,
    *,
    replace: bool,
) -> dict[str, Any]:
    for statement in render_dataset_sql(manifest, replace=replace):
        execute_statement(client, statement)

    tables: list[dict[str, Any]] = []
    for table in manifest.tables:
        base = f'"{manifest.catalog}"."{manifest.schema_name}"."{table.name}"'
        columns, rows, _ = execute_statement(
            client,
            "SELECT "
            "CAST((SELECT snapshot_id FROM " + base[:-1] + "$refs\" WHERE name = 'main') AS VARCHAR) AS snapshot_id, "
            f"(SELECT count(*) FROM {base}) AS row_count, "
            "(SELECT count(*) FROM " + base[:-1] + "$files\") AS file_count, "
            "(SELECT coalesce(sum(file_size_in_bytes), 0) FROM " + base[:-1] + "$files\") AS storage_bytes",
        )
        values = dict(zip(columns, rows[0], strict=True))
        tables.append({
            "name": table.name,
            "snapshotId": str(values["snapshot_id"]),
            "rowCount": int(values["row_count"]),
            "fileCount": int(values["file_count"]),
            "storageBytes": int(values["storage_bytes"]),
            "partitionSpec": table.partition_spec,
        })

    return {
        "receiptVersion": "1",
        "fixtureId": manifest.fixture_id,
        "fixtureVersion": manifest.fixture_version,
        "manifestHash": manifest.canonical_hash(),
        "generatorVersion": manifest.generator_version,
        "seed": manifest.seed,
        "runtimeProfile": manifest.runtime_profile,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "tables": tables,
    }


def cleanup_dataset(manifest: BenchmarkDatasetManifest, client: TrinoClient) -> dict[str, Any]:
    statements = render_cleanup_sql(manifest)
    for statement in statements:
        execute_statement(client, statement)
    return {
        "cleanupVersion": "1",
        "fixtureId": manifest.fixture_id,
        "fixtureVersion": manifest.fixture_version,
        "manifestHash": manifest.canonical_hash(),
        "schema": manifest.schema_name,
        "tablesRemoved": [table.name for table in manifest.tables],
    }
