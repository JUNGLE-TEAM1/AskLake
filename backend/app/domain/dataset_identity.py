"""Canonical identity and physical-location projection for Catalog writes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class DatasetIdentity:
    dataset_id: str
    name: str
    storage_location: str | None
    version: str | None
    query_engine_table: tuple[str, str, str, str] | None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "DatasetIdentity":
        table = payload.get("queryEngineTable")
        table_identity: tuple[str, str, str, str] | None = None
        if isinstance(table, dict):
            values = tuple(str(table.get(key) or "").strip() for key in ("catalog", "schema", "table", "format"))
            if all(values):
                table_identity = values
        materialization_runs = payload.get("materializationRuns")
        latest_run = (
            materialization_runs[0]
            if isinstance(materialization_runs, list)
            and materialization_runs
            and isinstance(materialization_runs[0], dict)
            else {}
        )
        version = str(
            payload.get("icebergSnapshotId")
            or latest_run.get("runId")
            or payload.get("sourceRunId")
            or ""
        ).strip() or None
        return cls(
            dataset_id=str(payload.get("id") or "").strip(),
            name=str(payload.get("name") or "").strip(),
            storage_location=str(payload.get("storageLocation") or "").strip() or None,
            version=version,
            query_engine_table=table_identity,
        )

    def require_publishable(self) -> None:
        if not self.dataset_id or not self.name:
            raise ValueError("Catalog publication requires dataset id and name.")

    def same_version_as(self, other: "DatasetIdentity") -> bool:
        return (
            self.dataset_id == other.dataset_id
            and self.version is not None
            and self.version == other.version
            and self.storage_location == other.storage_location
            and self.query_engine_table == other.query_engine_table
        )
