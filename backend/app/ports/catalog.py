"""Payload-level Catalog ports shared by ETL and SQL application services."""

from __future__ import annotations

from typing import Any, Protocol

from sqlalchemy.orm import Session


class CatalogReaderPort(Protocol):
    @property
    def db(self) -> Session: ...

    def get_dataset_payload(self, dataset_id: str) -> dict[str, Any] | None: ...

    def get_dataset_payload_for_update(self, dataset_id: str) -> dict[str, Any] | None: ...

    def get_dataset_payload_by_name(self, dataset_name: str) -> dict[str, Any] | None: ...

    def get_lineage_payload(self, dataset_id: str) -> dict[str, Any] | None: ...


class CatalogWriterPort(CatalogReaderPort, Protocol):
    def save_dataset_payload(
        self,
        payload: dict[str, Any],
        *,
        commit: bool = True,
    ) -> dict[str, Any]: ...


CatalogPort = CatalogWriterPort
