from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import uuid4


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings
from app.services.clickhouse_client import (
    ClickHouseClient,
    qualified_clickhouse_table,
    quote_clickhouse_string,
)
from app.services.clickhouse_static_snapshot_cache import (
    ClickHouseStaticSnapshotCache,
    STATIC_CACHE_REGISTRY_TABLE,
    static_snapshot_cache_identity,
)
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier
from app.services.trino_client import TrinoClient


def qualified_trino_table(table: str) -> str:
    return ".".join(
        quote_trino_identifier(item)
        for item in (settings.trino_catalog, "asklake", table)
    )


def latest_snapshot(client: TrinoClient, table: str) -> str:
    snapshots = ".".join(
        quote_trino_identifier(item)
        for item in (settings.trino_catalog, "asklake", f"{table}$snapshots")
    )
    result = execute_trino_rows(
        client,
        f"SELECT snapshot_id FROM {snapshots} ORDER BY committed_at DESC LIMIT 1",
    )
    if not result.rows:
        raise RuntimeError("Iceberg cache-refresh fixture has no committed snapshot")
    return str(result.rows[0][0])


def table_count(client: ClickHouseClient, table: str) -> int:
    result = client.query(
        f"SELECT count() FROM {qualified_clickhouse_table(settings.clickhouse_database, table)}"
    )
    return int(result.rows[0][0])


def run() -> dict[str, object]:
    suffix = uuid4().hex[:10]
    dataset_id = f"cache-refresh-{suffix}"
    iceberg_table = f"cache_refresh_{suffix}"
    first_table = f"asklake_cache_refresh_{suffix}_v1"
    second_table = f"asklake_cache_refresh_{suffix}_v2"
    source = qualified_trino_table(iceberg_table)
    trino = TrinoClient(settings)
    clickhouse = ClickHouseClient(settings)
    cache = ClickHouseStaticSnapshotCache(settings, trino)
    relation = {
        "datasetId": dataset_id,
        "mode": "static",
        "queryEngineTable": {
            "catalog": settings.trino_catalog,
            "schema": "asklake",
            "table": iceberg_table,
            "format": "iceberg",
        },
        "schema": [["id", "bigint"], ["name", "string"]],
        "schemaFingerprint": f"{dataset_id}-schema-v1",
        "referencedColumns": ["id", "name"],
    }
    try:
        execute_trino_rows(
            trino,
            f"CREATE SCHEMA IF NOT EXISTS {quote_trino_identifier(settings.trino_catalog)}.asklake",
        )
        execute_trino_rows(trino, f"DROP TABLE IF EXISTS {source}")
        execute_trino_rows(
            trino,
            f"CREATE TABLE {source} (id BIGINT, name VARCHAR) WITH (format = 'PARQUET')",
        )
        execute_trino_rows(
            trino,
            f"INSERT INTO {source} VALUES (1, 'Alice'), (2, 'Bob')",
        )
        first_snapshot = latest_snapshot(trino, iceberg_table)
        first_binding = {
            "datasetId": dataset_id,
            "snapshotId": first_snapshot,
            "schemaFingerprint": relation["schemaFingerprint"],
        }
        resolved_first = cache.resolve(
            clickhouse,
            database=settings.clickhouse_database,
            preferred_table=first_table,
            relation=relation,
            binding=first_binding,
            join_columns=["id"],
        )

        execute_trino_rows(
            trino,
            f"INSERT INTO {source} VALUES (3, 'Cara')",
        )
        second_snapshot = latest_snapshot(trino, iceberg_table)
        second_binding = {
            "datasetId": dataset_id,
            "snapshotId": second_snapshot,
            "schemaFingerprint": relation["schemaFingerprint"],
        }
        resolved_second = cache.resolve(
            clickhouse,
            database=settings.clickhouse_database,
            preferred_table=second_table,
            relation=relation,
            binding=second_binding,
            join_columns=["id"],
        )

        first_count = table_count(clickhouse, resolved_first)
        second_count = table_count(clickhouse, resolved_second)
        first_identity = static_snapshot_cache_identity(
            relation, first_binding, ["id"]
        )
        second_identity = static_snapshot_cache_identity(
            relation, second_binding, ["id"]
        )
        if first_snapshot == second_snapshot:
            raise RuntimeError("Iceberg fixture snapshot did not advance")
        if first_identity.cache_key == second_identity.cache_key:
            raise RuntimeError("Static cache identity did not change with the snapshot")
        if resolved_first == resolved_second:
            raise RuntimeError("Refreshed static snapshot reused the stale ClickHouse table")
        if (first_count, second_count) != (2, 3):
            raise RuntimeError(
                "Static cache tables do not match their pinned snapshots: "
                f"first={first_count} second={second_count}"
            )
        return {
            "ok": True,
            "datasetId": dataset_id,
            "firstSnapshotId": first_snapshot,
            "secondSnapshotId": second_snapshot,
            "firstCacheKey": first_identity.cache_key,
            "secondCacheKey": second_identity.cache_key,
            "firstTable": resolved_first,
            "secondTable": resolved_second,
            "firstRowCount": first_count,
            "secondRowCount": second_count,
        }
    finally:
        for table in (first_table, second_table):
            try:
                clickhouse.execute(
                    "DROP TABLE IF EXISTS "
                    f"{qualified_clickhouse_table(settings.clickhouse_database, table)}"
                )
            except Exception:
                pass
        try:
            clickhouse.execute(
                "ALTER TABLE "
                f"{qualified_clickhouse_table(settings.clickhouse_database, STATIC_CACHE_REGISTRY_TABLE)} "
                f"DELETE WHERE dataset_id = {quote_clickhouse_string(dataset_id)} "
                "SETTINGS mutations_sync = 1"
            )
        except Exception:
            pass
        clickhouse.close()
        try:
            execute_trino_rows(trino, f"DROP TABLE IF EXISTS {source}")
        except Exception:
            pass


if __name__ == "__main__":
    print(json.dumps(run(), ensure_ascii=False, indent=2))
