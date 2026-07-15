import csv
import io
import json
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx

from .errors import PermanentRagContractError


MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_ROWS = 1000


def read_manifest_rows(manifest: dict[str, Any], *, dataset_id: str, limit: int = MAX_SOURCE_ROWS) -> list[dict[str, Any]]:
    validate_manifest(manifest, dataset_id=dataset_id)
    url = str(manifest["readUrl"])
    source_format = str(manifest["format"]).casefold()
    with httpx.Client(timeout=60.0, follow_redirects=False) as client:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            content_length = int(response.headers.get("content-length") or 0)
            if content_length > MAX_SOURCE_BYTES:
                raise PermanentRagContractError("Catalog source manifest exceeds the bounded source read size")
            if source_format in {"jsonl", "ndjson"}:
                return _read_jsonl(response.iter_lines(), limit)
            if source_format == "csv":
                return _read_csv(response.iter_lines(), limit)
            if source_format == "json":
                body = b"".join(chunk for chunk in response.iter_bytes())
                if len(body) > MAX_SOURCE_BYTES:
                    raise PermanentRagContractError("Catalog source manifest exceeds the bounded source read size")
                payload = json.loads(body.decode("utf-8"))
                if not isinstance(payload, list):
                    raise PermanentRagContractError("JSON RAG source must be an array of rows")
                return [row for row in payload[:limit] if isinstance(row, dict)]
    raise PermanentRagContractError(f"Unsupported RAG source format: {source_format}")


def validate_manifest(manifest: dict[str, Any], *, dataset_id: str) -> None:
    if manifest.get("manifestVersion") != 1:
        raise PermanentRagContractError("Unsupported Catalog source manifest version")
    if str(manifest.get("datasetId") or "") != dataset_id:
        raise PermanentRagContractError("Source manifest Dataset does not match the RAG job")
    if not manifest.get("fingerprint"):
        raise PermanentRagContractError("Catalog source manifest fingerprint is required")
    expires_at = str(manifest.get("expiresAt") or "")
    if not expires_at:
        raise PermanentRagContractError("Catalog source manifest expiry is required")
    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PermanentRagContractError("Catalog source manifest expiry is invalid") from exc
    if expires <= datetime.now(timezone.utc):
        raise PermanentRagContractError("Catalog source manifest has expired")
    parsed = urlparse(str(manifest.get("readUrl") or ""))
    allowed_hosts = {host.strip().casefold() for host in os.environ.get("RAG_SOURCE_ALLOWED_HOSTS", "").split(",") if host.strip()}
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or (allowed_hosts and (parsed.hostname or "").casefold() not in allowed_hosts):
        raise PermanentRagContractError("Catalog source manifest readUrl is not allowed")


def _read_jsonl(lines: Any, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    total_bytes = 0
    for line in lines:
        line_bytes = len(line.encode("utf-8"))
        total_bytes += line_bytes
        if line_bytes > MAX_SOURCE_BYTES or total_bytes > MAX_SOURCE_BYTES:
            raise PermanentRagContractError("A source row exceeds the bounded source size")
        if not line.strip():
            continue
        value = json.loads(line)
        if isinstance(value, dict):
            rows.append(value)
        if len(rows) >= limit:
            break
    return rows


def _read_csv(lines: Any, limit: int) -> list[dict[str, Any]]:
    source_lines: list[str] = []
    total_bytes = 0
    for line in lines:
        total_bytes += len(line.encode("utf-8"))
        if total_bytes > MAX_SOURCE_BYTES:
            raise PermanentRagContractError("Catalog source manifest exceeds the bounded source read size")
        source_lines.append(line)
    text = io.StringIO("\n".join(source_lines))
    return list(__import__("itertools").islice(csv.DictReader(text), limit))
