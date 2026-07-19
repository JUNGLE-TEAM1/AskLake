from __future__ import annotations

from dataclasses import dataclass

from app.realtime.domain.source_boundary import SourceBoundary
from app.realtime.repositories.materialization_repository import MaterializationRepository
from app.realtime.sql.clickhouse_compiler import ClickHouseMaterialization
from app.services.clickhouse_client import ClickHouseClient, qualified_clickhouse_table, quote_clickhouse_string


@dataclass(frozen=True)
class MaterializationEvidence:
    materialization_id: str
    source_fingerprint: str
    target_row_count: int
    target_checksum: str
    reconciled: bool


class RealtimeMaterializer:
    def __init__(self, clickhouse: ClickHouseClient, repository: MaterializationRepository) -> None:
        self.clickhouse = clickhouse
        self.repository = repository

    def run(
        self,
        compiled: ClickHouseMaterialization,
        *,
        pipeline_version_id: str,
        boundary: SourceBoundary,
        dimension_version_ids: dict[str, str],
        lease_generation: int,
        serving_database: str,
        serving_current_view: str = "serving_current_v2",
    ) -> MaterializationEvidence:
        reserved = self.repository.reserve(
            materialization_id=compiled.materialization_id,
            pipeline_version_id=pipeline_version_id,
            boundary=boundary,
            source_fingerprint=compiled.source_fingerprint,
            dimension_version_ids=dimension_version_ids,
            clickhouse_query_id=compiled.clickhouse_query_id,
            lease_generation=lease_generation,
        )
        if not reserved:
            raise RuntimeError("materialization reservation conflicts with existing identity")
        if not self.repository.mark_running(
            materialization_id=compiled.materialization_id,
            lease_generation=lease_generation,
        ):
            raise RuntimeError("materialization lease is stale")

        try:
            before = self._evidence(
                database=serving_database,
                view=serving_current_view,
                materialization_id=compiled.materialization_id,
                source_fingerprint=compiled.source_fingerprint,
            )
            reconciled = before.target_row_count > 0
            if reconciled:
                if not self.repository.mark_reconciling(
                    materialization_id=compiled.materialization_id,
                    lease_generation=lease_generation,
                ):
                    raise RuntimeError("materialization reconcile lease is stale")
                evidence = before
            else:
                self.clickhouse.execute(
                    compiled.insert_sql,
                    database=serving_database,
                    query_id=compiled.clickhouse_query_id,
                )
                evidence = self._evidence(
                    database=serving_database,
                    view=serving_current_view,
                    materialization_id=compiled.materialization_id,
                    source_fingerprint=compiled.source_fingerprint,
                )
        except Exception as exc:
            self.repository.mark_failed(
                materialization_id=compiled.materialization_id,
                lease_generation=lease_generation,
                error_code=getattr(exc, "code", type(exc).__name__),
            )
            raise
        if not self.repository.mark_materialized(
            materialization_id=compiled.materialization_id,
            lease_generation=lease_generation,
            target_row_count=evidence.target_row_count,
            target_checksum=evidence.target_checksum,
        ):
            raise RuntimeError("materialization evidence commit lost its lease")
        return MaterializationEvidence(
            materialization_id=compiled.materialization_id,
            source_fingerprint=compiled.source_fingerprint,
            target_row_count=evidence.target_row_count,
            target_checksum=evidence.target_checksum,
            reconciled=reconciled,
        )

    def _evidence(
        self,
        *,
        database: str,
        view: str,
        materialization_id: str,
        source_fingerprint: str,
    ) -> MaterializationEvidence:
        target = qualified_clickhouse_table(database, view)
        result = self.clickhouse.query(
            "SELECT count() AS row_count, "
            "lower(hex(SHA256(arrayStringConcat(arraySort(groupArray("
            "concat(serving_key, ':', toString(row_version), ':', payload)"
            ")), '\\n')))) AS checksum "
            f"FROM {target} "
            f"WHERE materialization_id = {quote_clickhouse_string(materialization_id)} "
            f"AND source_fingerprint = {quote_clickhouse_string(source_fingerprint)}",
            database=database,
        )
        if not result.rows or len(result.rows[0]) < 2:
            raise RuntimeError("ClickHouse materialization evidence is unavailable")
        return MaterializationEvidence(
            materialization_id=materialization_id,
            source_fingerprint=source_fingerprint,
            target_row_count=int(result.rows[0][0] or 0),
            target_checksum=str(result.rows[0][1] or ""),
            reconciled=False,
        )
