"""Idempotent payload publication shared by ETL and SQL writers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.domain.dataset_identity import DatasetIdentity
from app.ports.catalog import CatalogWriterPort


@dataclass(frozen=True, slots=True)
class CatalogPublicationResult:
    payload: dict[str, Any]
    status: str


def publish_catalog_payload(
    writer: CatalogWriterPort,
    payload: dict[str, Any],
    *,
    require_version_identity: bool = False,
) -> CatalogPublicationResult:
    identity = DatasetIdentity.from_payload(payload)
    identity.require_publishable()
    existing = writer.get_dataset_payload(identity.dataset_id)
    if existing is not None:
        existing_identity = DatasetIdentity.from_payload(existing)
        if identity.same_version_as(existing_identity):
            return CatalogPublicationResult(payload=existing, status="already_published")
    if require_version_identity and identity.version is None:
        raise ValueError("Catalog materialization publication requires a run or snapshot version.")
    return CatalogPublicationResult(payload=writer.save_dataset_payload(payload), status="published")
