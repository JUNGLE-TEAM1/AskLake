import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

from app.config import Settings
from app.mcp_client import McpContextClient


def test_healthcheck_supplies_transport_context_without_calling_catalog_tools() -> None:
    captured_headers: dict[str, str] = {}

    @asynccontextmanager
    async def fake_streamable_http_client(url: str, *, http_client):
        assert url == "http://backend:8080/internal/mcp"
        captured_headers.update(dict(http_client.headers))
        yield object(), object(), None

    class FakeSession:
        def __init__(self, read: object, write: object) -> None:
            del read, write

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback) -> None:
            del exc_type, exc, traceback

        async def initialize(self) -> None:
            return None

        async def list_tools(self):
            return SimpleNamespace(
                tools=[SimpleNamespace(name="asklake.catalog.get_datasets_context")]
            )

    settings = Settings(
        app_env="testing",
        provider="mock",
        mcp_enabled=True,
        mcp_server_url="http://backend:8080/internal/mcp",
        mcp_service_token="mcp-secret",
    )

    with (
        patch("app.mcp_client.streamable_http_client", fake_streamable_http_client),
        patch("app.mcp_client.ClientSession", FakeSession),
    ):
        ready = asyncio.run(McpContextClient(settings).healthcheck())

    assert ready is True
    assert captured_headers["authorization"] == "Bearer mcp-secret"
    assert captured_headers["x-asklake-ai-context"] == "asklake-mcp-healthcheck"
