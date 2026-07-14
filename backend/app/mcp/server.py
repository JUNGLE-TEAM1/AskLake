import hmac
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import AsyncContextManager

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from app.core.config import settings
from app.mcp.catalog import (
    CATALOG_CONTEXT_BATCH_TOOL_NAME,
    CATALOG_CONTEXT_TOOL_NAME,
    get_dataset_context,
    get_datasets_context,
)
from app.mcp.context import install_request_context_token, reset_request_context_token


def _configured_mcp_route() -> str:
    configured_path = settings.ai_mcp_path.rstrip("/")
    leaf = configured_path.rsplit("/", 1)[-1]
    return f"/{leaf or 'mcp'}"


class ServiceTokenASGI:
    """Small pure-ASGI guard that runs before the MCP transport."""

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        configured_token = settings.ai_mcp_service_token
        if not configured_token:
            response = JSONResponse(
                {"error": "Internal MCP service token is not configured"},
                status_code=503,
            )
            await response(scope, receive, send)
            return

        request_token = _bearer_token(Headers(scope=scope).get("authorization"))
        if not request_token or not hmac.compare_digest(request_token, configured_token):
            response = JSONResponse({"error": "Unauthorized"}, status_code=401)
            await response(scope, receive, send)
            return

        context_token = Headers(scope=scope).get("x-asklake-ai-context")
        if not context_token:
            response = JSONResponse({"error": "AI context is required"}, status_code=401)
            await response(scope, receive, send)
            return
        context_state = install_request_context_token(context_token)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_request_context_token(context_state)


def create_mcp_components() -> tuple[ServiceTokenASGI, Callable[[], AsyncContextManager[None]]]:
    server = FastMCP(
        "AskLake Catalog",
        instructions="Read-only, scoped catalog context for the internal AI server.",
        json_response=True,
        stateless_http=True,
        streamable_http_path=_configured_mcp_route(),
        transport_security=TransportSecuritySettings(
            allowed_hosts=["backend", "backend:8080", "testserver", "localhost:*", "127.0.0.1:*"]
        ),
    )
    server.tool(
        name=CATALOG_CONTEXT_TOOL_NAME,
        description="Load bounded catalog context for one authorized dataset.",
    )(get_dataset_context)
    server.tool(
        name=CATALOG_CONTEXT_BATCH_TOOL_NAME,
        description="Load bounded catalog context for multiple authorized datasets in one request.",
    )(get_datasets_context)
    streamable_app = ServiceTokenASGI(server.streamable_http_app())

    @asynccontextmanager
    async def lifespan() -> AsyncIterator[None]:
        async with server.session_manager.run():
            yield

    return streamable_app, lifespan


def _bearer_token(value: str | None) -> str | None:
    if not value:
        return None
    scheme, separator, token = value.partition(" ")
    if not separator or scheme.casefold() != "bearer":
        return None
    token = token.strip()
    return token or None
