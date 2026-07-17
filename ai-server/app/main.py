import asyncio
import hashlib
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status

from .auth import require_internal_bearer
from .config import Settings, get_settings
from .llm_client import (
    LLMClient,
    ProviderConfigurationError,
    ProviderError,
    ProviderGeneration,
    ProviderResponseError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    create_llm_client,
)
from .mcp_client import McpContextClient, McpContextError
from .schemas import EmbeddingRequest, EmbeddingResponse, GenerateRequest, GenerateResponse, GenerationUsage, compact_json_size


logger = logging.getLogger(__name__)


async def send_json(send: Any, status_code: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class BodySizeLimitMiddleware:
    """Reject oversized bodies before FastAPI parses them."""

    def __init__(self, app: Any, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        content_lengths = [value for name, value in scope.get("headers", []) if name == b"content-length"]
        if len(content_lengths) > 1:
            await send_json(send, status.HTTP_400_BAD_REQUEST, {"detail": "Duplicate Content-Length"})
            return
        if content_lengths:
            content_length = content_lengths[0]
            try:
                parsed_length = int(content_length)
                if parsed_length < 0:
                    raise ValueError
                if parsed_length > self.max_bytes:
                    await send_json(send, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, {"detail": "Request body too large"})
                    return
            except ValueError:
                await send_json(send, status.HTTP_400_BAD_REQUEST, {"detail": "Invalid Content-Length"})
                return

        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > self.max_bytes:
                await send_json(send, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, {"detail": "Request body too large"})
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break

        body = b"".join(chunks)
        delivered = False

        async def replay_receive() -> dict[str, Any]:
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay_receive, send)


class ContextReplayGuard:
    """Consumes one signed context per generation request in this gateway instance."""

    def __init__(self, max_entries: int) -> None:
        self._seen: dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._max_entries = max_entries

    async def consume(self, context_token: str, request_id: str, ttl_seconds: int) -> bool:
        now = time.monotonic()
        key = hashlib.sha256(f"{request_id}\x00{context_token}".encode("utf-8")).hexdigest()
        async with self._lock:
            self._seen = {item: expires for item, expires in self._seen.items() if expires > now}
            if key in self._seen:
                return False
            if len(self._seen) >= self._max_entries:
                # The database-backed MCP consumption table remains the
                # authoritative cross-replica replay control. Evict only this
                # instance's earliest optimization entry to keep memory bounded.
                earliest = min(self._seen, key=self._seen.__getitem__)
                self._seen.pop(earliest, None)
            self._seen[key] = now + ttl_seconds
            return True


def validate_request_limits(request: GenerateRequest, settings: Settings) -> None:
    if len(request.prompt) > settings.max_prompt_chars:
        raise HTTPException(status_code=422, detail="Prompt exceeds the configured character limit")
    if request.current_query is not None and len(request.current_query) > settings.max_current_query_chars:
        raise HTTPException(status_code=422, detail="Current query exceeds the configured character limit")
    if len(request.context) > settings.max_context_items:
        raise HTTPException(status_code=422, detail="Context item limit exceeded")
    try:
        context_size = compact_json_size(request.context)
        tools_size = compact_json_size(request.tools)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Context and tools must contain JSON values") from exc
    if context_size > settings.max_context_bytes:
        raise HTTPException(status_code=422, detail="Context payload exceeds the configured size limit")
    if len(request.tools) > settings.max_tool_payloads:
        raise HTTPException(status_code=422, detail="Tool payload limit exceeded")
    if tools_size > settings.max_tool_payload_bytes:
        raise HTTPException(status_code=422, detail="Tool payload exceeds the configured size limit")


def provider_http_exception(error: ProviderError) -> HTTPException:
    if isinstance(error, ProviderConfigurationError):
        return HTTPException(status_code=503, detail="AI provider is not configured")
    if isinstance(error, ProviderTimeoutError):
        return HTTPException(status_code=504, detail="AI provider request timed out")
    if isinstance(error, (ProviderUnavailableError, ProviderResponseError)):
        return HTTPException(status_code=502, detail="AI provider request failed")
    return HTTPException(status_code=502, detail="AI provider request failed")


def create_app(settings: Settings | None = None, llm_client: LLMClient | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    client = llm_client or create_llm_client(app_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await app.state.llm_client.close()

    app = FastAPI(title=app_settings.app_name, version="1.0.0", lifespan=lifespan)
    app.state.settings = app_settings
    app.state.llm_client = client
    app.state.mcp_client = McpContextClient(app_settings)
    app.state.context_replay_guard = ContextReplayGuard(app_settings.context_replay_max_entries)
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=app_settings.max_request_bytes)

    @app.get("/health")
    async def health(response: Response) -> dict[str, object]:
        primary_provider_configured = bool(
            app_settings.provider_api_key and app_settings.provider_api_key.get_secret_value()
        )
        fallback_provider_configured = bool(
            app_settings.provider_fallback_base_url
            and app_settings.provider_fallback_api_key
            and app_settings.provider_fallback_api_key.get_secret_value()
        )
        provider_configured = (
            app_settings.provider == "mock"
            or primary_provider_configured
            or fallback_provider_configured
        )
        configured_default_model = (
            app_settings.provider_model
            if app_settings.provider == "mock" or primary_provider_configured
            else app_settings.provider_fallback_model or app_settings.provider_model
        )
        provider_probe = getattr(app.state.llm_client, "healthcheck", None)
        provider_ready = provider_configured and (
            bool(await provider_probe()) if callable(provider_probe) else True
        )
        mcp_configured = bool(
            app_settings.mcp_server_url
            and app_settings.mcp_service_token
            and app_settings.mcp_service_token.get_secret_value()
        )
        mcp_ready = not app_settings.mcp_enabled or (
            mcp_configured and await app.state.mcp_client.healthcheck()
        )
        ready = bool(app_settings.internal_auth_token and app_settings.internal_auth_token.get_secret_value()) and provider_ready and mcp_ready
        response.status_code = status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE
        return {
            "status": "ok" if ready else "unavailable",
            "service": "ai-gateway",
            "provider": app_settings.provider,
            "model": configured_default_model,
            "mcp": "ready" if mcp_ready and app_settings.mcp_enabled else "disabled" if not app_settings.mcp_enabled else "unavailable",
            "checks": {
                "internalAuth": "ready" if app_settings.internal_auth_token and app_settings.internal_auth_token.get_secret_value() else "unavailable",
                "provider": "ready" if provider_ready else "unavailable" if provider_configured else "unconfigured",
                "mcp": "ready" if mcp_ready and app_settings.mcp_enabled else "disabled" if not app_settings.mcp_enabled else "unavailable",
            },
            "routing": {
                mode: (
                    app_settings.model_for_mode(mode)
                    if app_settings.provider == "mock" or primary_provider_configured
                    else app_settings.provider_fallback_model or app_settings.model_for_mode(mode)
                )
                for mode in ["query_sql", "dashboard_assistant", "etl_transform", "rag_query_plan", "review_row"]
            },
            "capabilities": [
                "query_sql",
                "classify_dataset",
                "segment_document",
                "etl_transform",
                "dashboard_assistant",
                "review_schema",
                "review_row",
                "rag_query_plan",
                "rag_relevance",
                "embeddings",
            ],
        }

    @app.post("/v1/generate", response_model=GenerateResponse, dependencies=[Depends(require_internal_bearer)])
    async def generate(request: GenerateRequest, response: Response, request_context: Request) -> GenerateResponse:
        validate_request_limits(request, app_settings)
        request_id = request.request_id or str(uuid4())
        response.headers["X-Request-ID"] = request_id
        request_started = time.perf_counter()
        mcp_duration_ms = 0.0
        context_token = request_context.headers.get("X-AskLake-AI-Context", "")
        requires_catalog_context = (
            app_settings.mcp_enabled
            and request.mode in {"query_sql", "dashboard_assistant"}
            and bool(request.selected_dataset_ids)
        )
        if requires_catalog_context and not context_token:
            raise HTTPException(status_code=401, detail="AI context is required")
        if requires_catalog_context:
            if not request.request_id:
                raise HTTPException(status_code=422, detail="request_id is required with MCP context")
            if not await app.state.context_replay_guard.consume(
                context_token,
                request_id,
                app_settings.context_replay_ttl_seconds,
            ):
                raise HTTPException(status_code=409, detail="AI context has already been consumed")
            mcp_started = time.perf_counter()
            try:
                catalog_context = await app.state.mcp_client.get_catalog_context(
                    dataset_ids=request.selected_dataset_ids,
                    context_token=context_token,
                    base_dataset_id=request.base_dataset_id,
                    request_id=request_id,
                )
            except McpContextError as exc:
                raise HTTPException(status_code=502, detail="MCP catalog context request failed") from exc
            mcp_duration_ms = (time.perf_counter() - mcp_started) * 1000
            resolved_context = (
                {**catalog_context, "ragContext": request.rag_context}
                if request.mode == "query_sql"
                else {
                    **request.context,
                    "catalogContext": catalog_context,
                    "ragContext": request.rag_context,
                }
            )
            request = request.model_copy(update={"context": resolved_context})
            validate_request_limits(request, app_settings)
        elif request.rag_context:
            request = request.model_copy(update={"context": {**request.context, "ragContext": request.rag_context}})
            validate_request_limits(request, app_settings)
        generation_started = time.perf_counter()
        try:
            generated = await app.state.llm_client.generate(request)
        except ProviderError as exc:
            logger.warning(
                "ai_generation_failed request_id=%s provider=%s reason=%s",
                request_id,
                app.state.llm_client.provider_name,
                exc.__class__.__name__,
            )
            raise provider_http_exception(exc) from exc
        if isinstance(generated, ProviderGeneration):
            output = generated.output
            provider_name = generated.provider
            model_name = generated.model
            usage = generated.usage
        else:
            output = generated
            provider_name = app.state.llm_client.provider_name
            model_name = app.state.llm_client.model_name
            usage = GenerationUsage()
        generation_duration_ms = (time.perf_counter() - generation_started) * 1000
        total_duration_ms = (time.perf_counter() - request_started) * 1000
        response.headers["X-AI-MCP-Duration-MS"] = f"{mcp_duration_ms:.2f}"
        response.headers["X-AI-Generation-Duration-MS"] = f"{generation_duration_ms:.2f}"
        response.headers["X-AI-Total-Duration-MS"] = f"{total_duration_ms:.2f}"
        response.headers["Server-Timing"] = (
            f"mcp;dur={mcp_duration_ms:.2f}, "
            f"generation;dur={generation_duration_ms:.2f}, "
            f"total;dur={total_duration_ms:.2f}"
        )
        logger.info(
            "ai_generation_completed request_id=%s provider=%s model=%s mcp=%s generation_duration_ms=%.2f total_duration_ms=%.2f input_tokens=%s output_tokens=%s estimated_cost_usd=%.8f",
            request_id,
            provider_name,
            model_name,
            app_settings.mcp_enabled,
            generation_duration_ms,
            total_duration_ms,
            usage.input_tokens,
            usage.output_tokens,
            usage.estimated_cost_usd,
        )
        return GenerateResponse(
            request_id=request_id,
            mode=request.mode,
            output=output,
            provider=provider_name,
            model=model_name,
            usage=usage,
        )

    @app.post("/v1/embeddings", response_model=EmbeddingResponse, dependencies=[Depends(require_internal_bearer)])
    async def embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
        if len(request.input) > app_settings.embedding_batch_size:
            raise HTTPException(status_code=422, detail="Embedding batch exceeds the configured limit")
        if app_settings.provider == "mock":
            vectors = []
            for value in request.input:
                digest = hashlib.sha256(value.encode("utf-8")).digest()
                vectors.append([((digest[index % len(digest)] / 255.0) * 2) - 1 for index in range(app_settings.embedding_dimensions)])
            return EmbeddingResponse(
                provider="mock",
                model=request.model,
                dimensions=app_settings.embedding_dimensions,
                data=vectors,
            )
        try:
            create_embeddings = getattr(app.state.llm_client, "create_embeddings", None)
            if not callable(create_embeddings):
                raise ProviderConfigurationError("Provider embeddings are not configured")
            return await create_embeddings(request)
        except ProviderError as exc:
            raise provider_http_exception(exc) from exc

    return app


app = create_app()
