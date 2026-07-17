"""Dependency-free correlation, redaction, structured logging, and counters."""

from __future__ import annotations

from collections import Counter
from contextvars import ContextVar, Token
import json
import logging
import re
from threading import Lock
from time import perf_counter
from typing import Any, Mapping
from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


CORRELATION_ID_HEADER = "X-Correlation-ID"
MAX_CORRELATION_ID_LENGTH = 128
_CORRELATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SECRET_KEY_PATTERN = re.compile(
    r"(?i)(?:^|[_-])(?:authorization|cookie|credentials?|password|secret|token|access[_-]?key|private[_-]?key|api[_-]?key)$|"
    r"(?:password|secret|credential|accesskey|privatekey|apikey)$"
)
_SECRET_VALUE_PATTERN = re.compile(
    r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+|"
    r"((?:password|secret|token|access[_-]?key)\s*[=:]\s*)[^\s,;]+"
)
_correlation_id: ContextVar[str | None] = ContextVar("asklake_correlation_id", default=None)
_metric_counts: Counter[str] = Counter()
_metric_lock = Lock()


def normalize_correlation_id(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    if not candidate or len(candidate) > MAX_CORRELATION_ID_LENGTH:
        return None
    return candidate if _CORRELATION_ID_PATTERN.fullmatch(candidate) else None


def new_correlation_id() -> str:
    return uuid4().hex


def current_correlation_id() -> str | None:
    return _correlation_id.get()


def ensure_correlation_id(candidate: str | None = None) -> str:
    correlation_id = normalize_correlation_id(candidate) or current_correlation_id() or new_correlation_id()
    _correlation_id.set(correlation_id)
    return correlation_id


def bind_correlation_id(correlation_id: str) -> Token[str | None]:
    return _correlation_id.set(correlation_id)


def reset_correlation_id(token: Token[str | None]) -> None:
    _correlation_id.reset(token)


def redact(value: Any, *, max_string_length: int = 2_000) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if _SECRET_KEY_PATTERN.search(str(key)) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        compact = value[:max_string_length]
        return _SECRET_VALUE_PATTERN.sub(
            lambda match: f"{match.group(1) or match.group(2)}[REDACTED]",
            compact,
        )
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:max_string_length]


def increment_metric(name: str, amount: int = 1, **labels: object) -> None:
    label_text = ",".join(f"{key}={labels[key]}" for key in sorted(labels))
    metric_key = f"{name}{{{label_text}}}" if label_text else name
    with _metric_lock:
        _metric_counts[metric_key] += amount


def metrics_snapshot() -> dict[str, int]:
    with _metric_lock:
        return dict(sorted(_metric_counts.items()))


def reset_metrics_for_test() -> None:
    with _metric_lock:
        _metric_counts.clear()


def log_event(logger: logging.Logger, event: str, *, level: int = logging.INFO, **fields: Any) -> None:
    payload = {"event": event, "correlationId": current_correlation_id(), **fields}
    logger.log(level, json.dumps(redact(payload), ensure_ascii=False, separators=(",", ":")))


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        correlation_id = normalize_correlation_id(request.headers.get(CORRELATION_ID_HEADER)) or new_correlation_id()
        token = bind_correlation_id(correlation_id)
        request.state.correlation_id = correlation_id
        started_at = perf_counter()
        increment_metric("http_requests_started_total", method=request.method)
        try:
            response = await call_next(request)
            response.headers[CORRELATION_ID_HEADER] = correlation_id
            increment_metric(
                "http_requests_completed_total",
                method=request.method,
                status_family=f"{response.status_code // 100}xx",
            )
            log_event(
                logging.getLogger("asklake.http"),
                "http_request_completed",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                durationMs=round((perf_counter() - started_at) * 1000, 2),
            )
            return response
        except Exception:
            increment_metric("http_requests_failed_total", method=request.method)
            raise
        finally:
            reset_correlation_id(token)
