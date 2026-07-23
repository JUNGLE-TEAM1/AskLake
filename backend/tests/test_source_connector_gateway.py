from __future__ import annotations

import unittest
from unittest.mock import patch

from pydantic import ValidationError

from app.application.source_connectors import (
    list_source_assets,
    test_source_connector as run_source_connector,
)
from app.infrastructure.source_connectors import (
    NodeSourceConnectorGateway,
    SOURCE_CONNECTOR_TIMEOUT_SECONDS,
)
from app.schemas.etl import SourceAssetsRequest, SourceConnectorRequest
from app.services import etl_service


def analysis_payload() -> dict:
    return {
        "actionPath": "/api/etl/sources/test",
        "assets": [],
        "draftPatch": {
            "source": {
                "connectionMessage": "Connection succeeded",
                "connectionStatus": "success",
                "sourceConfig": [["Bucket", "raw"]],
                "sourceLabel": "raw/orders",
                "sourceType": "File / S3",
            },
        },
        "logs": ["connector ready"],
        "message": "Connection succeeded",
        "previewColumns": ["id"],
        "previewNote": "1 row",
        "previewRows": [["1"]],
        "status": "success",
        "testItems": [["Connection", "pass"]],
    }


class FakeSourceConnectorGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.test_result = analysis_payload()
        self.asset_result = {
            "assets": [["orders", "folder", "raw/orders/"]],
            "count": 1,
            "limit": 200,
            "prefix": "raw/",
        }

    def test_source(self, **request):
        self.calls.append(("test_source", request))
        return self.test_result

    def list_assets(self, **request):
        self.calls.append(("list_assets", request))
        return self.asset_result


class RecordingNodeBridge:
    def __init__(self, result: dict) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self.result = result

    def execute(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


class SourceConnectorApplicationTests(unittest.TestCase):
    def test_etl_service_remains_a_thin_connector_facade(self) -> None:
        gateway = FakeSourceConnectorGateway()
        request = SourceConnectorRequest.model_validate({
            "sourceConfig": [["Bucket", "raw"]],
            "sourceType": "File / S3",
        })

        with patch(
            "app.services.etl_service.NodeSourceConnectorGateway",
            return_value=gateway,
        ) as gateway_factory:
            response = etl_service.test_source_connector(request)

        self.assertEqual(response.status, "success")
        gateway_factory.assert_called_once_with()

    def test_python_use_case_owns_request_and_analysis_schema(self) -> None:
        gateway = FakeSourceConnectorGateway()
        request = SourceConnectorRequest.model_validate({
            "sourceConfig": [["Bucket", "raw"]],
            "sourceType": "File / S3",
        })

        response = run_source_connector(request, gateway=gateway)

        self.assertEqual(response.status, "success")
        self.assertEqual(response.draft_patch.source.source_label, "raw/orders")
        self.assertEqual(gateway.calls, [(
            "test_source",
            {
                "source_type": "File / S3",
                "source_config": [("Bucket", "raw")],
            },
        )])

    def test_python_use_case_owns_asset_prefix_and_response_schema(self) -> None:
        gateway = FakeSourceConnectorGateway()
        request = SourceAssetsRequest.model_validate({
            "prefix": "raw/",
            "sourceConfig": [["Bucket", "raw"]],
            "sourceType": "File / S3",
        })

        response = list_source_assets(request, gateway=gateway)

        self.assertEqual(response.count, 1)
        self.assertEqual(response.assets[0], ("orders", "folder", "raw/orders/"))
        self.assertEqual(gateway.calls[0][1]["prefix"], "raw/")

    def test_malformed_node_result_fails_at_the_python_schema_boundary(self) -> None:
        gateway = FakeSourceConnectorGateway()
        gateway.test_result = {"status": "success"}
        request = SourceConnectorRequest(sourceType="Kafka", sourceConfig=[])

        with self.assertRaises(ValidationError):
            run_source_connector(request, gateway=gateway)


class NodeSourceConnectorGatewayTests(unittest.TestCase):
    def test_connector_probe_keeps_existing_script_marker_payload_and_timeout(self) -> None:
        result = analysis_payload()
        bridge = RecordingNodeBridge(result)
        gateway = NodeSourceConnectorGateway(bridge)

        response = gateway.test_source(
            source_type="File / S3",
            source_config=[("Bucket", "raw")],
        )

        self.assertIs(response, result)
        args, options = bridge.calls[0]
        self.assertEqual(args, (
            "test-source-connector.mjs",
            "ASKLAKE_SOURCE_CONNECTOR_RESULT",
            {"sourceConfig": [("Bucket", "raw")], "sourceType": "File / S3"},
        ))
        self.assertEqual(options, {
            "error_marker": "ASKLAKE_SOURCE_CONNECTOR_ERROR",
            "timeout_seconds": SOURCE_CONNECTOR_TIMEOUT_SECONDS,
        })

    def test_asset_listing_keeps_existing_script_marker_prefix_and_timeout(self) -> None:
        result = {"assets": [], "prefix": "raw/"}
        bridge = RecordingNodeBridge(result)
        gateway = NodeSourceConnectorGateway(bridge)

        response = gateway.list_assets(
            source_type="File / S3",
            source_config=[("Bucket", "raw")],
            prefix="raw/",
        )

        self.assertIs(response, result)
        args, options = bridge.calls[0]
        self.assertEqual(args, (
            "list-source-assets.mjs",
            "ASKLAKE_SOURCE_ASSETS_RESULT",
            {
                "prefix": "raw/",
                "sourceConfig": [("Bucket", "raw")],
                "sourceType": "File / S3",
            },
        ))
        self.assertEqual(options, {
            "error_marker": "ASKLAKE_SOURCE_ASSETS_ERROR",
            "timeout_seconds": SOURCE_CONNECTOR_TIMEOUT_SECONDS,
        })


if __name__ == "__main__":
    unittest.main()
