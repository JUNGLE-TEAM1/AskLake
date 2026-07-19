#!/usr/bin/env python3
from __future__ import annotations

import os
import json
import subprocess
from uuid import uuid4

from app.core.config import settings
from app.realtime.domain.archive import ArchiveParityReport, ParityEvidence
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.services.clickhouse_client import ClickHouseClient, ClickHouseRows, qualified_clickhouse_table


class ContainerClickHouseClient:
    """Local Docker fallback when Docker Desktop does not publish the declared loopback port."""

    def __init__(self, container: str) -> None:
        self.container = container

    def execute(self, query: str, *, database: str, query_id=None) -> str:
        return self._run(query, database=database)

    def query(self, query: str, *, database: str) -> ClickHouseRows:
        payload = json.loads(self._run(f"{query.strip().rstrip(';')} FORMAT JSON", database=database))
        columns = [str(item["name"]) for item in payload["meta"]]
        return ClickHouseRows(
            columns=columns,
            rows=[[row.get(column) for column in columns] for row in payload["data"]],
        )

    def close(self) -> None:
        return None

    def _run(self, query: str, *, database: str) -> str:
        command = [
            "docker", "exec", self.container, "clickhouse-client",
            "--user", settings.clickhouse_user,
            "--password", settings.clickhouse_password or "",
            "--database", database,
            "--query", query,
        ]
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
        if completed.returncode != 0:
            raise RuntimeError("ClickHouse container query failed: " + completed.stderr.strip()[:500])
        return completed.stdout


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_CLICKHOUSE_RECOVERY", "").lower() != "true":
        raise RuntimeError("Set ASKLAKE_VERIFY_CLICKHOUSE_RECOVERY=true for disposable ClickHouse verification.")
    suffix = uuid4().hex[:10]
    hot_table = f"parity_hot_{suffix}"
    archive_table = f"parity_archive_{suffix}"
    database = settings.clickhouse_database
    container = os.environ.get("CLICKHOUSE_DOCKER_CONTAINER", "").strip()
    client = ContainerClickHouseClient(container) if container else ClickHouseClient(settings)
    try:
        for table in (hot_table, archive_table):
            target = qualified_clickhouse_table(database, table)
            client.execute(f"""
                CREATE TABLE {target}
                (
                    topic String,
                    partition UInt32,
                    source_offset UInt64,
                    amount Decimal(18, 2),
                    payload String,
                    schema_fingerprint String,
                    nullable_value Nullable(String),
                    is_error UInt8
                )
                ENGINE = MergeTree
                ORDER BY (topic, partition, source_offset)
            """, database=database)
            client.execute(f"""
                INSERT INTO {target}
                SELECT
                    'clicks.v2',
                    toUInt32(number % 2),
                    intDiv(number, 2),
                    toDecimal64(number + 1, 2),
                    concat('row-', toString(number)),
                    'schema-live-v1',
                    'present',
                    toUInt8(0)
                FROM numbers(100)
            """, database=database)

        hot = collect(client, database, hot_table, "hot", f"hot-{suffix}")
        archive = collect(client, database, archive_table, "archive", f"archive-{suffix}")
        report = ArchiveParityReport.compare(hot, archive)
        assert report.matched, report.mismatch_fields
        assert hot.row_count == 100 and hot.distinct_source_position_count == 100
        assert [item.to_offset_inclusive for item in hot.boundary.partitions] == [49, 49]
        print("verify-clickhouse-v2-recovery-live: ok")
    finally:
        for table in (hot_table, archive_table):
            try:
                client.execute(
                    f"DROP TABLE IF EXISTS {qualified_clickhouse_table(database, table)}",
                    database=database,
                )
            except Exception:
                pass
        client.close()


def collect(client, database, table, role, binding_version_id):
    target = qualified_clickhouse_table(database, table)
    metrics = client.query(f"""
        SELECT
            count() AS row_count,
            uniqExact(tuple(topic, partition, source_offset)) AS position_count,
            any(schema_fingerprint) AS schema_fingerprint,
            countIf(isNull(nullable_value)) AS null_count,
            sum(is_error) AS error_count,
            toString(sum(amount)) AS amount_sum,
            toString(groupBitXor(cityHash64(topic, partition, source_offset, payload))) AS checksum,
            toString(groupBitXor(cityHash64(source_offset, payload))) AS sample_hash
        FROM {target}
    """, database=database).rows[0]
    partition_rows = client.query(f"""
        SELECT partition, min(source_offset), max(source_offset)
        FROM {target}
        GROUP BY partition
        ORDER BY partition
    """, database=database).rows
    boundary = SourceBoundary.build(
        PartitionBoundary(
            "clicks.v2",
            int(row[0]),
            int(row[1]) - 1,
            int(row[2]),
        )
        for row in partition_rows
    )
    return ParityEvidence(
        role=role,
        dataset_id="live-parity-fixture",
        pipeline_version_id="pipeline-live-v1",
        binding_version_id=binding_version_id,
        boundary=boundary,
        dimension_version_ids={"users": "users-live-v1"},
        row_count=int(metrics[0]),
        checksum=str(metrics[6]),
        distinct_source_position_count=int(metrics[1]),
        schema_fingerprint=str(metrics[2]),
        null_count=int(metrics[3]),
        error_count=int(metrics[4]),
        numeric_sums={"amount": metrics[5]},
        sample_hash=str(metrics[7]),
    )


if __name__ == "__main__":
    main()
