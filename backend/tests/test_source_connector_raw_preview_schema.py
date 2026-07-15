import unittest

from app.schemas.etl import SourceConnectorAnalysis


class SourceConnectorRawPreviewSchemaTests(unittest.TestCase):
    def test_kafka_raw_preview_metadata_survives_fastapi_validation(self) -> None:
        payload = {
            "actionPath": "/api/etl/sources/kafka/test",
            "assets": [],
            "draftPatch": {
                "source": {
                    "connectionMessage": "connected",
                    "connectionStatus": "success",
                    "detectedFormat": "JSONL",
                    "rawPreviewLines": ['{"event_id":"EVT-1"}'],
                    "requiresRecordParsing": False,
                    "sourceConfig": [],
                    "sourceLabel": "redpanda:9092/events",
                    "sourceType": "Stream / Kafka",
                },
            },
            "logs": [],
            "message": "connected",
            "previewColumns": ["event_id"],
            "previewNote": "sample",
            "previewRows": [["EVT-1"]],
            "status": "success",
            "testItems": [],
        }

        validated = SourceConnectorAnalysis.model_validate(payload)
        serialized = validated.model_dump(by_alias=True)
        source = serialized["draftPatch"]["source"]

        self.assertEqual(source["detectedFormat"], "JSONL")
        self.assertEqual(source["rawPreviewLines"], ['{"event_id":"EVT-1"}'])
        self.assertFalse(source["requiresRecordParsing"])


if __name__ == "__main__":
    unittest.main()
