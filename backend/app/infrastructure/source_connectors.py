"""Node compatibility adapter for the canonical source connector runtime."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.infrastructure.runtime_io import SubprocessNodeBridge
from app.ports.runtime_io import NodeBridgePort


BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
SOURCE_CONNECTOR_TIMEOUT_SECONDS = 120


class NodeSourceConnectorGateway:
    """Hide legacy script markers behind connector-specific operations."""

    def __init__(self, bridge: NodeBridgePort | None = None) -> None:
        self._bridge = bridge or SubprocessNodeBridge(
            backend_dir=BACKEND_DIR,
            scripts_dir=SCRIPTS_DIR,
        )

    def test_source(
        self,
        *,
        source_type: str,
        source_config: Any,
    ) -> dict[str, Any]:
        return self._bridge.execute(
            "test-source-connector.mjs",
            "ASKLAKE_SOURCE_CONNECTOR_RESULT",
            {
                "sourceConfig": source_config,
                "sourceType": source_type,
            },
            error_marker="ASKLAKE_SOURCE_CONNECTOR_ERROR",
            timeout_seconds=SOURCE_CONNECTOR_TIMEOUT_SECONDS,
        )

    def list_assets(
        self,
        *,
        source_type: str,
        source_config: Any,
        prefix: str,
    ) -> dict[str, Any]:
        return self._bridge.execute(
            "list-source-assets.mjs",
            "ASKLAKE_SOURCE_ASSETS_RESULT",
            {
                "prefix": prefix,
                "sourceConfig": source_config,
                "sourceType": source_type,
            },
            error_marker="ASKLAKE_SOURCE_ASSETS_ERROR",
            timeout_seconds=SOURCE_CONNECTOR_TIMEOUT_SECONDS,
        )
