import base64
import binascii
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re

from fastapi import status
from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.schemas.trino import TrinoQueryEstimate
from app.services.trino_client import TrinoClient


_SIZE_PATTERN = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(B|KIB|KB|MIB|MB|GIB|GB|TIB|TB|PIB|PB)\s*$", re.IGNORECASE)
_SIZE_MULTIPLIERS = {
    "B": 1,
    "KB": 1024,
    "KIB": 1024,
    "MB": 1024**2,
    "MIB": 1024**2,
    "GB": 1024**3,
    "GIB": 1024**3,
    "TB": 1024**4,
    "TIB": 1024**4,
    "PB": 1024**5,
    "PIB": 1024**5,
}
_PLAN_SIZE_PATTERN = re.compile(r"Estimates:\s*\{[^}]*?rows:\s*[^()]+\(([^)]+)\)", re.IGNORECASE)


def build_query_estimate(
    *,
    actor: ActorContext,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
    runtime_settings: Settings,
    iceberg_estimated_bytes: int | None = None,
    plan_estimated_bytes: int | None = None,
    plan_unavailable: bool = False,
) -> TrinoQueryEstimate:
    input_sizes = [dataset_storage_size(dataset) for dataset in context_datasets]
    known_input_bytes = sum(size for size in input_sizes if size is not None)
    unknown_datasets = [dataset.name for dataset, size in zip(context_datasets, input_sizes, strict=True) if size is None]
    normalized_query = " ".join(query.upper().split())
    join_count = len(re.findall(r"\bJOIN\b", normalized_query))
    multiplier = 1 + (join_count * 0.25)
    if "CROSS JOIN" in normalized_query:
        multiplier *= 2
    catalog_estimated_bytes = int(known_input_bytes * multiplier) if known_input_bytes else None
    available_estimates = [value for value in (plan_estimated_bytes, catalog_estimated_bytes) if value is not None]
    estimated_bytes = iceberg_estimated_bytes if iceberg_estimated_bytes is not None else (max(available_estimates) if available_estimates else None)
    if iceberg_estimated_bytes is not None:
        estimate_source = "iceberg_metadata"
    elif plan_estimated_bytes is not None and catalog_estimated_bytes is not None and catalog_estimated_bytes > plan_estimated_bytes:
        estimate_source = "conservative_bound"
    elif plan_estimated_bytes is not None:
        estimate_source = "trino_plan"
    else:
        estimate_source = "catalog_heuristic"
    warnings: list[str] = []
    if unknown_datasets and plan_estimated_bytes is None and iceberg_estimated_bytes is None:
        warnings.append(f"크기 정보를 확인할 수 없는 데이터셋: {', '.join(unknown_datasets)}")
        warnings.append("Trino plan과 Catalog 크기를 확인할 수 없어 실행 전 확인이 필요합니다.")
    elif unknown_datasets and iceberg_estimated_bytes is None:
        warnings.append("Catalog 크기 정보는 없지만 Trino plan 추정치를 사용합니다.")
    if estimate_source == "conservative_bound":
        warnings.append("Trino plan 추정치보다 원본 크기가 커 보수적 추정치를 사용합니다.")
    if join_count:
        warnings.append(f"JOIN {join_count}개가 포함되어 있어 실제 처리량이 입력 크기보다 커질 수 있습니다.")
    if plan_unavailable and iceberg_estimated_bytes is None:
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
        (unknown_datasets and plan_estimated_bytes is None and iceberg_estimated_bytes is None)
        or (
            estimated_bytes is not None
            and runtime_settings.trino_query_warning_bytes > 0
            and estimated_bytes >= runtime_settings.trino_query_warning_bytes
        )
    )
    duration_seconds, duration_source, estimated_throughput = estimate_duration(
        estimated_bytes=estimated_bytes,
        configured_throughput=runtime_settings.trino_query_estimated_throughput_bytes_per_second,
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
        estimatedDurationSeconds=duration_seconds,
        durationEstimateSource=duration_source,
        estimatedThroughputBytesPerSecond=estimated_throughput,
        estimateSource=estimate_source,
        icebergEstimatedBytes=iceberg_estimated_bytes,
        knownInputBytes=known_input_bytes,
        planEstimatedBytes=plan_estimated_bytes,
        riskLevel=risk_level,
        warnings=warnings,
    )


def estimate_iceberg_scan_bytes(
    *,
    client: TrinoClient,
    context_datasets: list[CatalogDatasetResponse],
    query: str,
) -> int | None:
    try:
        expression = parse_one(query, read="trino")
    except ParseError:
        return None

    referenced_columns = {
        column.name.casefold()
        for column in expression.find_all(exp.Column)
        if column.name and column.name != "*"
    }
    reads_all_columns = any(
        not isinstance(star.parent, exp.Count)
        for star in expression.find_all(exp.Star)
    )
    total_bytes = 0
    for dataset in context_datasets:
        mapping = dataset.query_engine_table
        schema_columns = [name for name, _type in dataset.schema_]
        if mapping is None or mapping.format != "iceberg" or not schema_columns:
            return None
        selected_columns = (
            schema_columns
            if reads_all_columns
            else [name for name in schema_columns if name.casefold() in referenced_columns]
        )
        if not selected_columns:
            continue
        dataset_bytes = query_iceberg_column_bytes(client, dataset, selected_columns)
        if dataset_bytes is None:
            return None
        if len(selected_columns) == len(schema_columns) and dataset.storage_size_bytes is not None:
            dataset_bytes = max(dataset_bytes, dataset.storage_size_bytes)
        total_bytes += dataset_bytes
    return total_bytes


def query_iceberg_column_bytes(
    client: TrinoClient,
    dataset: CatalogDatasetResponse,
    columns: list[str],
) -> int | None:
    mapping = dataset.query_engine_table
    if mapping is None:
        return None
    column_expressions = [
        "COALESCE(TRY_CAST(json_extract_scalar("
        "element_at(TRY_CAST(readable_metrics AS map(varchar, json)), "
        f"{quote_string_literal(column)}), '$.column_size') AS bigint), 0)"
        for column in columns
    ]
    files_table = f"{mapping.table}$files"
    statement = (
        "SELECT COALESCE(SUM(" + " + ".join(column_expressions) + "), 0) "
        "FROM " + ".".join(quote_identifier(value) for value in [mapping.catalog, mapping.schema_, files_table]) + " "
        "WHERE content = 0"
    )
    page = client.submit(statement)
    pages = 0
    while True:
        if page.error is not None:
            return None
        for row in page.rows:
            if row and row[0] is not None:
                try:
                    return max(0, int(row[0]))
                except (TypeError, ValueError):
                    return None
        if not page.next_uri or pages >= 20:
            return None
        page = client.fetch(page.next_uri)
        pages += 1


def estimate_duration(
    *,
    estimated_bytes: int | None,
    configured_throughput: int,
) -> tuple[float | None, str, int]:
    if estimated_bytes is None:
        return None, "configured_throughput", configured_throughput
    return (
        max(0.1, round(estimated_bytes / configured_throughput, 1)),
        "configured_throughput",
        configured_throughput,
    )


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def quote_string_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


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


def dataset_storage_size(dataset: CatalogDatasetResponse) -> int | None:
    if dataset.storage_size_bytes is not None:
        return max(0, dataset.storage_size_bytes)
    return parse_dataset_size(dataset.size)


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
