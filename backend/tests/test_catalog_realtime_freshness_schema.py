import unittest

from app.schemas.catalog import CatalogDatasetResponse


class CatalogRealtimeFreshnessSchemaTests(unittest.TestCase):
    def test_catalog_schema_accepts_realtime_freshness(self) -> None:
        payload = {
            "createdBy": None,
            "description": "",
            "downstream": [],
            "freshness": "realtime",
            "id": "realtime",
            "layer": "GOLD",
            "lastUpdated": "",
            "name": "realtime",
            "nextRefresh": "streaming",
            "owner": "owner",
            "quality": "passed",
            "rag": False,
            "rows": "0",
            "sampleRows": [],
            "schema": [["id", "string"]],
            "size": "0",
            "source": "continuous-sql",
            "status": "available",
            "tags": [],
            "upstream": [],
        }

        response = CatalogDatasetResponse.model_validate(payload)

        self.assertEqual(response.freshness, "realtime")


if __name__ == "__main__":
    unittest.main()
