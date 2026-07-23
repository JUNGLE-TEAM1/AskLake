from __future__ import annotations

import unittest

from app.repositories.catalog_repository import normalize_dataset_payload
from app.schemas.catalog import CatalogDatasetResponse


class CatalogPayloadCompatibilityTests(unittest.TestCase):
    def test_payload_created_before_rag_removal_is_still_listable(self) -> None:
        payload = {
            "createdBy": None, "description": "", "downstream": [], "freshness": "latest",
            "id": "pre-rag-removal", "layer": "GOLD", "lastUpdated": "", "name": "legacy",
            "nextRefresh": "-", "owner": "owner", "quality": "passed",
            "rows": "0", "sampleRows": [], "schema": [["id", "string"]], "size": "0",
            "source": "sql", "status": "available", "tags": [], "upstream": [],
        }

        response = CatalogDatasetResponse.model_validate(normalize_dataset_payload(payload))

        self.assertFalse(response.rag)


if __name__ == "__main__":
    unittest.main()
