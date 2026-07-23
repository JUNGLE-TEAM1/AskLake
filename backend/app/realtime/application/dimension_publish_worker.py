from __future__ import annotations

from dataclasses import dataclass

from app.realtime.domain.dimension import DimensionRow, build_dimension_plan
from app.services.clickhouse_client import ClickHouseClient


@dataclass(frozen=True)
class DimensionPublishEvidence:
    row_count: int
    checksum: str
    physical_table: str


class DimensionPublishWorker:
    def __init__(self, clickhouse: ClickHouseClient) -> None:
        self.clickhouse = clickhouse

    def publish(
        self,
        *,
        database: str,
        scope_id: str = "deployment",
        dataset_id: str,
        version_id: str,
        semantics: str,
        rows: list[DimensionRow],
    ) -> DimensionPublishEvidence:
        if scope_id != "deployment":
            raise ValueError("dimension scope must be deployment")
        plan = build_dimension_plan(semantics=semantics, rows=rows)  # type: ignore[arg-type]
        if semantics == "current":
            table = "dimension_current_v2"
            columns = (
                "scope_id", "dimension_dataset_id", "dimension_version_id", "dimension_key",
                "payload", "row_version",
            )
            values = (
                (scope_id, dataset_id, version_id, row.key, row.canonical_payload(), row.row_version)
                for row in plan.rows
            )
        else:
            table = "dimension_temporal_v2"
            columns = (
                "scope_id", "dimension_dataset_id", "dimension_version_id", "dimension_key",
                "payload", "valid_from", "valid_to", "row_version",
            )
            values = (
                (
                    scope_id, dataset_id, version_id, row.key, row.canonical_payload(),
                    row.valid_from, row.valid_to, row.row_version,
                )
                for row in plan.rows
            )
        inserted = self.clickhouse.insert_json_rows(database, table, columns, values)
        if inserted != plan.row_count:
            raise RuntimeError("dimension insert count does not match validated plan")
        return DimensionPublishEvidence(plan.row_count, plan.checksum, table)
