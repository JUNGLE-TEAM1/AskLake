from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pydantic import ValidationError

from app.repositories.catalog_repository import normalize_dataset_payload
from app.schemas.catalog import CatalogDatasetResponse
from app.services.catalog_service import CatalogService


def catalog_payload(physical_bindings: object) -> dict[str, object]:
    return {
        "description": "Catalog compatibility fixture",
        "freshness": "latest",
        "id": "legacy-realtime-dataset",
        "layer": "GOLD",
        "lastUpdated": "2026-07-22T00:00:00Z",
        "name": "legacy_realtime_dataset",
        "nextRefresh": "-",
        "owner": "data-owner",
        "physicalBindings": physical_bindings,
        "quality": "통과",
        "rag": False,
        "rows": "3",
        "sampleRows": [],
        "schema": [["event_id", "String"]],
        "size": "1 KB",
        "source": "Kafka",
        "status": "available",
        "tags": ["realtime"],
    }


def clickhouse_binding() -> dict[str, object]:
    return {
        "bindingEpoch": 4,
        "database": "retired_realtime",
        "engine": "clickhouse",
        "role": "serving",
        "status": "active",
        "table": "events_current",
        "versionId": "serving-v4",
    }


def trino_binding() -> dict[str, object]:
    return {
        "bindingEpoch": 4,
        "catalog": "iceberg",
        "engine": "trino",
        "role": "archive",
        "schema": "gold",
        "snapshotId": "44",
        "status": "active",
        "table": "events_archive",
    }


class CatalogPayloadCompatibilityTests(unittest.TestCase):
    def test_payload_created_before_rag_removal_is_still_listable(self) -> None:
        payload = {
            "createdBy": None,
            "description": "",
            "downstream": [],
            "freshness": "latest",
            "id": "pre-rag-removal",
            "layer": "GOLD",
            "lastUpdated": "",
            "name": "legacy",
            "nextRefresh": "-",
            "owner": "owner",
            "quality": "passed",
            "rows": "0",
            "sampleRows": [],
            "schema": [["id", "string"]],
            "size": "0",
            "source": "sql",
            "status": "available",
            "tags": [],
            "upstream": [],
        }

        response = CatalogDatasetResponse.model_validate(normalize_dataset_payload(payload))

        self.assertFalse(response.rag)

    def test_catalog_list_service_accepts_v2_era_persisted_payload(self) -> None:
        payload = catalog_payload([clickhouse_binding(), trino_binding()])
        repository = SimpleNamespace(
            db=object(),
            list_dataset_models=lambda: [SimpleNamespace(payload=payload)],
        )
        service = CatalogService(None, repository, None)  # type: ignore[arg-type]

        with (
            patch(
                "app.services.catalog_service.datasets_with_persisted_permission_grants",
                side_effect=lambda _db, datasets: datasets,
            ),
            patch(
                "app.services.catalog_service.with_dataset_permissions",
                side_effect=lambda dataset, _actor, _db: dataset,
            ),
        ):
            result = service.list_datasets()

        self.assertEqual(len(result.datasets), 1)
        self.assertEqual(result.datasets[0].id, "legacy-realtime-dataset")
        self.assertEqual(len(result.datasets[0].physical_bindings), 1)
        self.assertEqual(result.datasets[0].physical_bindings[0].engine, "trino")

    def test_retired_clickhouse_binding_is_removed_while_trino_binding_is_preserved(self) -> None:
        payload = catalog_payload([clickhouse_binding(), trino_binding()])

        normalized = normalize_dataset_payload(payload)
        response = CatalogDatasetResponse.model_validate(normalized)

        self.assertEqual(len(response.physical_bindings), 1)
        self.assertEqual(response.physical_bindings[0].role, "archive")
        self.assertEqual(response.physical_bindings[0].engine, "trino")
        self.assertEqual(response.physical_bindings[0].table, "events_archive")
        self.assertEqual(len(payload["physicalBindings"]), 2)

    def test_enabled_ec2_profile_preserves_clickhouse_and_trino_bindings(self) -> None:
        payload = catalog_payload([clickhouse_binding(), trino_binding()])

        with patch(
            "app.repositories.catalog_repository.settings",
            SimpleNamespace(clickhouse_realtime_v2_enabled=True),
        ):
            response = CatalogDatasetResponse.model_validate(
                normalize_dataset_payload(payload)
            )

        self.assertEqual(
            [(binding.role, binding.engine) for binding in response.physical_bindings],
            [("serving", "clickhouse"), ("archive", "trino")],
        )

    def test_retired_clickhouse_only_payload_is_projected_without_bindings(self) -> None:
        normalized = normalize_dataset_payload(catalog_payload([clickhouse_binding()]))

        response = CatalogDatasetResponse.model_validate(normalized)

        self.assertEqual(response.physical_bindings, [])
        self.assertEqual(response.id, "legacy-realtime-dataset")
        self.assertEqual(response.schema_, [("event_id", "String")])

    def test_malformed_supported_binding_does_not_reach_catalog_response_validation(self) -> None:
        malformed_trino = trino_binding()
        malformed_trino.pop("schema")

        with self.assertRaises(ValidationError):
            CatalogDatasetResponse.model_validate(catalog_payload([malformed_trino]))

        normalized = normalize_dataset_payload(catalog_payload([
            "not-an-object",
            malformed_trino,
            trino_binding(),
        ]))
        response = CatalogDatasetResponse.model_validate(normalized)

        self.assertEqual(len(response.physical_bindings), 1)
        self.assertEqual(response.physical_bindings[0].table, "events_archive")

    def test_non_list_binding_uses_valid_query_engine_fallback(self) -> None:
        payload = catalog_payload({"unexpected": "object"})
        payload["bindingEpoch"] = 7
        payload["icebergSnapshotId"] = "77"
        payload["queryEngineTable"] = {
            "catalog": "iceberg",
            "format": "iceberg",
            "schema": "silver",
            "table": "orders_clean",
        }

        normalized = normalize_dataset_payload(payload)
        response = CatalogDatasetResponse.model_validate(normalized)

        self.assertEqual(len(response.physical_bindings), 1)
        self.assertEqual(response.physical_bindings[0].binding_epoch, 7)
        self.assertEqual(response.physical_bindings[0].schema_, "silver")
        self.assertEqual(response.physical_bindings[0].snapshot_id, "77")


if __name__ == "__main__":
    unittest.main()
