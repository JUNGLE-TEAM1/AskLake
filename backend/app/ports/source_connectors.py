"""Application-facing source connector runtime contract."""

from __future__ import annotations

from typing import Any, Protocol


class SourceConnectorGateway(Protocol):
    """Run the canonical connector implementation without exposing transport details."""

    def test_source(
        self,
        *,
        source_type: str,
        source_config: Any,
    ) -> dict[str, Any]: ...

    def list_assets(
        self,
        *,
        source_type: str,
        source_config: Any,
        prefix: str,
    ) -> dict[str, Any]: ...
