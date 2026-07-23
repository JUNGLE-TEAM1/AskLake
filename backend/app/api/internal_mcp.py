"""The private MCP ASGI application, intentionally outside the public /api router."""

from app.mcp.server import create_mcp_components
from app.core.config import settings


def _mount_path() -> str:
    configured_path = settings.ai_mcp_path.rstrip("/")
    parent = configured_path.rsplit("/", 1)[0]
    return parent or "/"


internal_mcp_mount_path = _mount_path()


def create_internal_mcp_app():
    return create_mcp_components()

__all__ = ["create_internal_mcp_app", "internal_mcp_mount_path"]
