"""Source connector use cases with explicit Python/Node ownership."""

from __future__ import annotations

from app.ports.source_connectors import SourceConnectorGateway
from app.schemas.etl import (
    SourceAssetsRequest,
    SourceAssetsResponse,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
)


def test_source_connector(
    request: SourceConnectorRequest,
    *,
    gateway: SourceConnectorGateway,
) -> SourceConnectorAnalysis:
    result = gateway.test_source(
        source_type=request.source_type,
        source_config=request.source_config,
    )
    return SourceConnectorAnalysis.model_validate(result)


def list_source_assets(
    request: SourceAssetsRequest,
    *,
    gateway: SourceConnectorGateway,
) -> SourceAssetsResponse:
    result = gateway.list_assets(
        source_type=request.source_type,
        source_config=request.source_config,
        prefix=request.prefix,
    )
    return SourceAssetsResponse.model_validate(result)
