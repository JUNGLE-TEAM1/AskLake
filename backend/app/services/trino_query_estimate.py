import base64
import binascii
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoQueryEstimate


_SIZE_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB)\s*$", re.IGNORECASE)
_SIZE_MULTIPLIERS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4, "PB": 1024**5}
_PLAN_SIZE_PATTERN = re.compile(r"Estimates:\s*\{[^}]*?rows:\s*[^()]+\(([^)]+)\)", re.IGNORECASE)


def build_query_estimate(
    *,
    actor: ActorContext,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
    runtime_settings: Settings,
    plan_estimated_bytes: int | None = None,
    plan_unavailable: bool = False,
) -> TrinoQueryEstimate:
    input_sizes = [parse_dataset_size(dataset.size) for dataset in context_datasets]
    known_input_bytes = sum(size for size in input_sizes if size is not None)
    unknown_datasets = [dataset.name for dataset, size in zip(context_datasets, input_sizes, strict=True) if size is None]
    normalized_query = " ".join(query.upper().split())
    join_count = len(re.findall(r"\bJOIN\b", normalized_query))
    multiplier = 1 + (join_count * 0.25)
    if "CROSS JOIN" in normalized_query:
        multiplier *= 2
    heuristic_bytes = int(known_input_bytes * multiplier) if known_input_bytes else None
    estimated_bytes = plan_estimated_bytes if plan_estimated_bytes is not None else heuristic_bytes
    warnings: list[str] = []
    if unknown_datasets and plan_estimated_bytes is None:
        warnings.append(f"크기 정보를 확인할 수 없는 데이터셋: {', '.join(unknown_datasets)}")
        warnings.append("Trino plan과 Catalog 크기를 확인할 수 없어 실행 전 확인이 필요합니다.")
    elif unknown_datasets:
        warnings.append("Catalog 크기 정보는 없지만 Trino plan 추정치를 사용합니다.")
    if join_count:
        warnings.append(f"JOIN {join_count}개가 포함되어 있어 실제 처리량이 입력 크기보다 커질 수 있습니다.")
    if plan_unavailable:
        warnings.append("Trino plan을 가져오지 못해 Catalog 크기 기반 추정치를 사용합니다.")
    if estimated_bytes is not None and estimated_bytes >= runtime_settings.trino_query_warning_bytes > 0:
        warnings.append("대용량 실행으로 확인이 필요합니다.")
    if estimated_bytes is None:
        risk_level = "medium" if unknown_datasets else "low"
    elif runtime_settings.trino_query_warning_bytes > 0 and estimated_bytes >= runtime_settings.trino_query_warning_bytes:
        risk_level = "high"
    elif join_count:
        risk_level = "medium"
    else:
        risk_level = "low"

    confirmation_required = bool(
        (unknown_datasets and plan_estimated_bytes is None)
        or (
            estimated_bytes is not None
            and runtime_settings.trino_query_warning_bytes > 0
            and estimated_bytes >= runtime_settings.trino_query_warning_bytes
        )
    )
    return TrinoQueryEstimate(
        confirmationRequired=confirmation_required,
        confirmationToken=create_confirmation_token(
            actor=actor,
            context_datasets=context_datasets,
            query=query,
            runtime_settings=runtime_settings,
        ) if confirmation_required else None,
        estimatedBytes=estimated_bytes,
        estimatedDurationSeconds=(
            max(1, round(estimated_bytes / runtime_settings.trino_query_estimated_throughput_bytes_per_second))
            if estimated_bytes is not None else None
        ),
        estimateSource="trino_plan" if plan_estimated_bytes is not None else "catalog_heuristic",
        knownInputBytes=known_input_bytes,
        riskLevel=risk_level,
        warnings=warnings,
    )


def require_estimate_confirmation(
    *,
    actor: ActorContext,
    confirmation_token: str | None,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
    runtime_settings: Settings,
    estimate: TrinoQueryEstimate | None = None,
) -> TrinoQueryEstimate:
    estimate = estimate or build_query_estimate(
        actor=actor,
        context_datasets=context_datasets,
        query=query,
        runtime_settings=runtime_settings,
    )
    if runtime_settings.trino_query_max_estimated_bytes > 0 and (
        estimate.estimated_bytes is not None
        and estimate.estimated_bytes > runtime_settings.trino_query_max_estimated_bytes
    ):
        raise ApiError(
            ErrorCode.CONFLICT,
            "Estimated query size exceeds the configured execution limit",
            status.HTTP_409_CONFLICT,
            {"estimatedBytes": estimate.estimated_bytes, "limitBytes": runtime_settings.trino_query_max_estimated_bytes},
        )
    if estimate.confirmation_required and not validate_confirmation_token(
        confirmation_token,
        actor=actor,
        context_datasets=context_datasets,
        query=query,
        runtime_settings=runtime_settings,
    ):
        raise ApiError(
            ErrorCode.QUERY_CONFIRMATION_REQUIRED,
            "Confirm the estimated query cost before executing",
            status.HTTP_409_CONFLICT,
            estimate.model_dump(by_alias=True, exclude_none=True),
        )
    return estimate


def parse_dataset_size(value: str) -> int | None:
    match = _SIZE_PATTERN.match(str(value or ""))
    if match is None:
        return None
    return int(float(match.group(1)) * _SIZE_MULTIPLIERS[match.group(2).upper()])


def parse_plan_estimated_bytes(plan: str) -> int | None:
    values = [parse_dataset_size(match.group(1)) for match in _PLAN_SIZE_PATTERN.finditer(plan)]
    known_values = [value for value in values if value is not None]
    return max(known_values) if known_values else None


def create_confirmation_token(
    *,
    actor: ActorContext,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
    runtime_settings: Settings,
) -> str:
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=runtime_settings.trino_query_confirmation_ttl_seconds)).isoformat()
    payload = {
        "actor": actor.id or actor.email or actor.name,
        "datasets": [dataset.id for dataset in context_datasets],
        "expiresAt": expires_at,
        "queryHash": query_hash(query),
        "version": 1,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(runtime_settings.trino_query_confirmation_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def validate_confirmation_token(
    token: str | None,
    *,
    actor: ActorContext,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
    runtime_settings: Settings,
) -> bool:
    if not token:
        return False
    try:
        encoded, signature = token.split(".", maxsplit=1)
        expected = hmac.new(runtime_settings.trino_query_confirmation_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8"))
        expiry = datetime.fromisoformat(str(payload["expiresAt"]).replace("Z", "+00:00"))
    except (AttributeError, KeyError, TypeError, ValueError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError):
        return False
    return bool(
        payload.get("version") == 1
        and payload.get("actor") == (actor.id or actor.email or actor.name)
        and payload.get("datasets") == [dataset.id for dataset in context_datasets]
        and payload.get("queryHash") == query_hash(query)
        and expiry > datetime.now(timezone.utc)
    )


def query_hash(query: str) -> str:
    return hashlib.sha256(" ".join(query.split()).encode("utf-8")).hexdigest()
