import json
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .config import Settings


class McpContextError(Exception):
    pass


class McpContextClient:
    """Minimal MCP client: one bounded read-only catalog tool, no agent loop."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def healthcheck(self) -> bool:
        if not self.settings.mcp_enabled:
            return True
        if not self.settings.mcp_server_url or not self.settings.mcp_service_token:
            return False
        headers = {"Authorization": f"Bearer {self.settings.mcp_service_token.get_secret_value()}"}
        try:
            timeout = httpx.Timeout(self.settings.mcp_timeout_seconds)
            async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=False) as http_client:
                async with streamable_http_client(self.settings.mcp_server_url, http_client=http_client) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.list_tools()
            names = {str(getattr(tool, "name", "")) for tool in getattr(result, "tools", [])}
            return "asklake.catalog.get_datasets_context" in names
        except Exception:
            return False

    async def get_catalog_context(
        self,
        *,
        dataset_ids: list[str],
        context_token: str,
        base_dataset_id: str | None,
        request_id: str,
    ) -> dict[str, Any]:
        if not self.settings.mcp_enabled:
            return {}
        if not self.settings.mcp_server_url or not self.settings.mcp_service_token:
            raise McpContextError("MCP catalog context is not configured")
        if not dataset_ids:
            raise McpContextError("At least one dataset is required for MCP context")
        headers = {
            "Authorization": f"Bearer {self.settings.mcp_service_token.get_secret_value()}",
            "X-AskLake-AI-Context": context_token,
        }
        try:
            timeout = httpx.Timeout(self.settings.mcp_timeout_seconds)
            async with httpx.AsyncClient(headers=headers, timeout=timeout, follow_redirects=False) as http_client:
                async with streamable_http_client(self.settings.mcp_server_url, http_client=http_client) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(
                            "asklake.catalog.get_datasets_context",
                            arguments={
                                "dataset_ids": dataset_ids,
                                "sample_row_limit": 5,
                                "request_id": request_id,
                            },
                        )
                        if getattr(result, "isError", False):
                            raise McpContextError("MCP catalog context request failed")
                        dataset_contexts = _decode_batch_tool_result(result, dataset_ids)
        except McpContextError:
            raise
        except httpx.TimeoutException as exc:
            raise McpContextError("MCP catalog context request timed out") from exc
        except Exception as exc:
            raise McpContextError("MCP catalog context request failed") from exc
        return {
            "baseDatasetId": base_dataset_id or dataset_ids[0],
            "datasets": dataset_contexts,
        }


def _decode_tool_result(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        # FastMCP wraps a function return value in ``result`` for tools with
        # an output schema. Normalize that transport detail at the boundary so
        # the rest of the gateway only handles the stable catalog shape.
        if set(structured) == {"result"}:
            value = structured["result"]
            if isinstance(value, dict):
                return value
            if isinstance(value, list):
                return {"datasets": value}
        return structured
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", None)
        if isinstance(text, str):
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as exc:
                raise McpContextError("MCP catalog context was not valid JSON") from exc
            if isinstance(payload, dict):
                return payload
    raise McpContextError("MCP catalog context was empty")


def _decode_batch_tool_result(result: Any, requested_dataset_ids: list[str]) -> list[dict[str, Any]]:
    payload = _decode_tool_result(result)
    datasets = payload.get("datasets")
    if not isinstance(datasets, list) or len(datasets) != len(requested_dataset_ids):
        raise McpContextError("MCP catalog batch context was incomplete")
    decoded: list[dict[str, Any]] = []
    for expected_dataset_id, item in zip(requested_dataset_ids, datasets, strict=True):
        if not isinstance(item, dict) or item.get("datasetId") != expected_dataset_id:
            raise McpContextError("MCP catalog batch context was out of order or invalid")
        decoded.append(item)
    return decoded
