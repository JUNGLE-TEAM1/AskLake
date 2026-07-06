import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import status

from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository, dataset_model_to_payload
from app.repositories.sql_repository import SqlRepository
from app.schemas.catalog import (
    CatalogDatasetListResponse,
    CatalogDatasetResponse,
    CreateDerivedDatasetRequest,
    LineageGraphColumn,
    LineageGraphDataset,
    LineageGraphEdge,
    LineageGraphResponse,
    LineageLayer,
)
from app.schemas.common import CursorPageMeta, ErrorCode
from app.schemas.sql import QueryRunResponse
from app.services.lake_storage_service import (
    LocalLakeStorageService,
    MaterializedDatasetResult,
)


class CatalogService:
    def __init__(
        self,
        lake_storage: LocalLakeStorageService,
        repository: CatalogRepository,
        sql_repository: SqlRepository,
    ) -> None:
        self.lake_storage = lake_storage
        self.repository = repository
        self.sql_repository = sql_repository

    def list_datasets(self) -> CatalogDatasetListResponse:
        datasets = [
            CatalogDatasetResponse.model_validate(dataset_model_to_payload(model))
            for model in self.repository.list_dataset_models()
        ]
        return CatalogDatasetListResponse(
            datasets=datasets,
            page=CursorPageMeta(cursor=None, has_next=False),
        )

    def get_dataset(self, dataset_id: str) -> CatalogDatasetResponse:
        payload = self.repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ApiError(ErrorCode.NOT_FOUND, "Dataset not found", status.HTTP_404_NOT_FOUND)
        return CatalogDatasetResponse.model_validate(payload)

    def get_dataset_lineage(self, dataset_id: str) -> LineageGraphResponse:
        dataset = self.get_dataset(dataset_id)
        lineage_payload = self.repository.get_lineage_payload(dataset_id)
        if lineage_payload is not None:
            return LineageGraphResponse.model_validate(lineage_payload)
        return build_fallback_lineage_graph(dataset)

    def create_derived_dataset(
        self,
        request: CreateDerivedDatasetRequest,
    ) -> CatalogDatasetResponse:
        request_source_dataset = self.get_dataset(request.source_dataset_id)
        sql_result = self.get_sql_result(request.source_run_id)
        validate_derived_dataset_request(request, sql_result)
        result_source_dataset = self.get_dataset(sql_result.dataset_id)

        reference_datasets = [
            self.get_dataset(reference_dataset_id)
            for reference_dataset_id in unique_values(request.reference_dataset_ids)
        ]
        schema_source_datasets = unique_datasets_by_id([
            result_source_dataset,
            *reference_datasets,
            request_source_dataset,
        ])
        dataset_name = build_derived_dataset_name(request, result_source_dataset)
        dataset_id = build_unique_derived_dataset_id(dataset_name, self.repository)
        materialized_result = self.lake_storage.materialize_sql_result(
            columns=sql_result.columns,
            dataset_id=dataset_id,
            layer=request.dataset.layer,
            rows=build_materialized_sql_rows(sql_result),
            source_run_id=request.source_run_id,
        )
        dataset_payload = build_derived_dataset_payload(
            request,
            dataset_id,
            dataset_name,
            materialized_result,
            result_source_dataset,
            sql_result,
            schema_source_datasets,
        )
        derived_dataset = CatalogDatasetResponse.model_validate(dataset_payload)
        lineage_graph = build_derived_dataset_lineage_graph(
            result_source_dataset,
            derived_dataset,
        )
        dataset_payload["lineageGraph"] = lineage_graph.model_dump(
            by_alias=True,
            mode="json",
        )

        saved_payload = self.repository.save_dataset_payload(dataset_payload)
        return CatalogDatasetResponse.model_validate(saved_payload)

    def get_sql_result(self, run_id: str) -> QueryRunResponse:
        payload = self.sql_repository.get_run_payload(run_id)
        if payload is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "SQL run not found",
                status.HTTP_404_NOT_FOUND,
                {"sourceRunId": run_id},
            )
        return QueryRunResponse.model_validate(payload)


def validate_derived_dataset_request(
    request: CreateDerivedDatasetRequest,
    sql_result: QueryRunResponse,
) -> None:
    valid_source_dataset_ids = {sql_result.dataset_id}
    if sql_result.base_dataset_id:
        valid_source_dataset_ids.add(sql_result.base_dataset_id)
    if request.source_dataset_id not in valid_source_dataset_ids:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Request source dataset does not match the source SQL run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {
                "sourceDatasetId": request.source_dataset_id,
                "sourceRunId": request.source_run_id,
            },
        )

    if request.query.strip() != sql_result.query.strip():
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Request query does not match the source SQL run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"sourceRunId": request.source_run_id},
        )

    if set(request.reference_dataset_ids) != set(sql_result.reference_dataset_ids):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Request reference datasets do not match the source SQL run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"sourceRunId": request.source_run_id},
        )

    if (
        request.preview_limit
        and sql_result.preview_limit
        and request.preview_limit != sql_result.preview_limit
    ):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Request preview limit does not match the source SQL run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"sourceRunId": request.source_run_id},
        )

    if (
        request.validation_key
        and sql_result.validation_key
        and request.validation_key != sql_result.validation_key
    ):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Request validation key does not match the source SQL run",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"sourceRunId": request.source_run_id},
        )


def build_derived_dataset_payload(
    request: CreateDerivedDatasetRequest,
    dataset_id: str,
    dataset_name: str,
    materialized_result: MaterializedDatasetResult,
    result_source_dataset: CatalogDatasetResponse,
    sql_result: QueryRunResponse,
    schema_source_datasets: list[CatalogDatasetResponse],
) -> dict[str, object]:
    dataset_description = (
        request.dataset.description.strip()
        or f"{result_source_dataset.name} SQL 결과로 생성한 분석 데이터셋"
    )
    upstream_reference_ids = [
        reference_dataset_id
        for reference_dataset_id in unique_values(request.reference_dataset_ids)
        if reference_dataset_id != result_source_dataset.id
    ]

    return {
        "description": dataset_description,
        "downstream": ["SQL 분석", "대시보드"],
        "freshness": "latest",
        "id": dataset_id,
        "layer": request.dataset.layer,
        "lastUpdated": current_utc_timestamp(),
        "name": dataset_name,
        "nextRefresh": "수동 갱신",
        "owner": result_source_dataset.owner,
        "quality": "SQL materialized",
        "rag": request.dataset.rag,
        "rows": f"{materialized_result.row_count:,} rows",
        "sampleRows": materialized_result.sample_rows,
        "schema": [
            [column_name, infer_column_type(schema_source_datasets, column_name)]
            for column_name in sql_result.columns
        ],
        "size": format_storage_size(materialized_result.storage_size_bytes),
        "source": f"SQL Materialize · {sql_result.run_id}",
        "sourceRunId": request.source_run_id,
        "status": "available",
        "storageFormat": materialized_result.storage_format,
        "storageLocation": materialized_result.storage_location,
        "storageSizeBytes": materialized_result.storage_size_bytes,
        "tags": normalize_derived_dataset_tags(request.dataset.tags),
        "upstream": [
            result_source_dataset.name,
            *upstream_reference_ids,
            request.source_run_id,
        ],
    }


def build_derived_dataset_name(
    request: CreateDerivedDatasetRequest,
    result_source_dataset: CatalogDatasetResponse,
) -> str:
    return request.dataset.name.strip() or f"{result_source_dataset.name}_analysis"


def build_materialized_sql_rows(
    sql_result: QueryRunResponse,
) -> list[list[str]]:
    column_count = len(sql_result.columns)
    return [
        [
            str(row[column_index]) if column_index < len(row) else ""
            for column_index in range(column_count)
        ]
        for row in sql_result.rows
    ]


def build_unique_derived_dataset_id(
    dataset_name: str,
    repository: CatalogRepository,
) -> str:
    base_dataset_id = f"ds_{normalize_derived_dataset_id(dataset_name)}"
    if repository.get_dataset_payload(base_dataset_id) is None:
        return base_dataset_id
    return f"{base_dataset_id}_{uuid4().hex[:8]}"


def normalize_derived_dataset_id(name: str) -> str:
    normalized_name = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    return normalized_name or "sql_derived"


def normalize_derived_dataset_tags(tags: list[str]) -> list[str]:
    normalized_tags = [
        tag if tag.startswith("#") else f"#{tag}"
        for tag in (raw_tag.strip() for raw_tag in tags)
        if tag
    ]
    return unique_values(normalized_tags or ["#sql-derived"])


def infer_column_type(
    datasets: list[CatalogDatasetResponse],
    column_name: str,
) -> str:
    for dataset in datasets:
        for schema_column_name, schema_column_type in dataset.schema_:
            if schema_column_name == column_name:
                return schema_column_type
    return "string"


def build_derived_dataset_lineage_graph(
    source_dataset: CatalogDatasetResponse,
    derived_dataset: CatalogDatasetResponse,
) -> LineageGraphResponse:
    source_graph = source_dataset.lineage_graph
    derived_node = build_dataset_node(derived_dataset)
    source_node = find_source_lineage_node(source_dataset, source_graph)
    graph_datasets = (
        [
            dataset
            for dataset in source_graph.datasets
            if dataset.id != derived_dataset.id
        ]
        if source_graph
        else []
    )
    if not any(dataset.id == source_node.id for dataset in graph_datasets):
        graph_datasets.append(source_node)

    graph_edges = (
        [
            edge
            for edge in source_graph.edges
            if (
                edge.from_dataset_id != derived_dataset.id
                and edge.to_dataset_id != derived_dataset.id
            )
        ]
        if source_graph
        else []
    )
    graph_edges.extend(build_derived_lineage_edges(source_node, derived_node))

    return LineageGraphResponse(
        dataset_id=derived_dataset.id,
        datasets=[*graph_datasets, derived_node],
        edges=graph_edges,
    )


def find_source_lineage_node(
    source_dataset: CatalogDatasetResponse,
    source_graph: LineageGraphResponse | None,
) -> LineageGraphDataset:
    if source_graph:
        for dataset in source_graph.datasets:
            if dataset.id == source_dataset.id:
                return dataset
    return build_dataset_node(source_dataset)


def build_derived_lineage_edges(
    source_node: LineageGraphDataset,
    derived_node: LineageGraphDataset,
) -> list[LineageGraphEdge]:
    edges: list[LineageGraphEdge] = []
    for column_index, target_column in enumerate(derived_node.columns):
        source_column = find_source_column(
            source_node.columns,
            target_column.name,
            column_index,
        )
        edges.append(
            LineageGraphEdge(
                from_column_id=source_column.id,
                from_dataset_id=source_node.id,
                to_column_id=target_column.id,
                to_dataset_id=derived_node.id,
            )
        )
    return edges


def find_source_column(
    source_columns: list[LineageGraphColumn],
    target_column_name: str,
    column_index: int,
) -> LineageGraphColumn:
    for source_column in source_columns:
        if source_column.name == target_column_name:
            return source_column
    if source_columns:
        return source_columns[column_index % len(source_columns)]
    return LineageGraphColumn(
        id=normalize_lineage_id(target_column_name),
        name=target_column_name,
        type="string",
    )


def unique_values(values: list[str]) -> list[str]:
    unique_items: list[str] = []
    seen_items: set[str] = set()
    for value in values:
        if not value or value in seen_items:
            continue
        unique_items.append(value)
        seen_items.add(value)
    return unique_items


def unique_datasets_by_id(
    datasets: list[CatalogDatasetResponse],
) -> list[CatalogDatasetResponse]:
    unique_datasets: list[CatalogDatasetResponse] = []
    seen_dataset_ids: set[str] = set()
    for dataset in datasets:
        if dataset.id in seen_dataset_ids:
            continue
        unique_datasets.append(dataset)
        seen_dataset_ids.add(dataset.id)
    return unique_datasets


def format_storage_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes}B"
    units = ["KB", "MB", "GB", "TB"]
    size = float(size_bytes)
    for unit in units:
        size /= 1024
        if size < 1024:
            return f"{size:.1f}{unit}"
    return f"{size:.1f}PB"


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def build_fallback_lineage_graph(dataset: CatalogDatasetResponse) -> LineageGraphResponse:
    current_node = build_dataset_node(dataset)
    upstream_nodes = [
        build_upstream_node(dataset, upstream_name, index, current_node.columns)
        for index, upstream_name in enumerate(dataset.upstream)
    ]
    lineage_nodes = [*upstream_nodes, current_node]
    lineage_edges = build_lineage_edges(upstream_nodes, current_node)

    return LineageGraphResponse(
        dataset_id=dataset.id,
        datasets=lineage_nodes,
        edges=lineage_edges,
    )


def build_dataset_node(dataset: CatalogDatasetResponse) -> LineageGraphDataset:
    return LineageGraphDataset(
        columns=[
            LineageGraphColumn(
                id=normalize_lineage_id(f"{dataset.id}-{name}"),
                name=name,
                type=column_type,
            )
            for name, column_type in dataset.schema_
        ],
        engine="ICEBERG",
        id=dataset.id,
        layer=dataset.layer,
        name=dataset.name,
    )


def build_upstream_node(
    dataset: CatalogDatasetResponse,
    upstream_name: str,
    index: int,
    target_columns: list[LineageGraphColumn],
) -> LineageGraphDataset:
    layer = infer_lineage_layer(upstream_name, dataset.layer, index)
    return LineageGraphDataset(
        columns=[
            LineageGraphColumn(
                id=normalize_lineage_id(f"{dataset.id}-{index}-{column.name}"),
                name=infer_upstream_column_name(column.name, layer, index),
                type=column.type,
            )
            for column in target_columns
        ],
        engine=infer_lineage_engine(upstream_name, layer),
        id=normalize_lineage_id(f"{dataset.id}-{upstream_name}"),
        layer=layer,
        name=get_lineage_table_name(upstream_name),
    )


def build_lineage_edges(
    upstream_nodes: list[LineageGraphDataset],
    current_node: LineageGraphDataset,
) -> list[LineageGraphEdge]:
    edges: list[LineageGraphEdge] = []
    for index, source_node in enumerate(upstream_nodes):
        target_node = (
            upstream_nodes[index + 1]
            if index + 1 < len(upstream_nodes)
            else current_node
        )
        if not source_node.columns or not target_node.columns:
            continue

        for column_index, target_column in enumerate(target_node.columns):
            source_column = source_node.columns[column_index % len(source_node.columns)]
            edges.append(
                LineageGraphEdge(
                    from_column_id=source_column.id,
                    from_dataset_id=source_node.id,
                    to_column_id=target_column.id,
                    to_dataset_id=target_node.id,
                )
            )
    return edges


def infer_lineage_engine(value: str, layer: LineageLayer) -> str:
    lower_value = value.lower()
    if "postgres" in lower_value:
        return "POSTGRESQL"
    if "kafka" in lower_value:
        return "KAFKA"
    if "s3" in lower_value:
        return "S3"
    if layer in {"SOURCE", "RAW"}:
        return "LAKE"
    return "ICEBERG"


def infer_lineage_layer(value: str, current_layer: str, index: int) -> LineageLayer:
    lower_value = value.lower()
    source_keywords = ("postgres", "kafka", "s3")
    if any(source_keyword in lower_value for source_keyword in source_keywords):
        return "SOURCE"
    if "raw" in lower_value:
        return "RAW"
    if "bronze" in lower_value or (current_layer == "SILVER" and index > 0):
        return "BRONZE"
    if "silver" in lower_value or current_layer == "GOLD":
        return "SILVER"
    return "BRONZE"


def infer_upstream_column_name(column_name: str, layer: LineageLayer, index: int) -> str:
    if layer == "SOURCE" and index > 0:
        return column_name.removeprefix("order_").replace("customer_", "user_", 1)
    return column_name


def get_lineage_table_name(value: str) -> str:
    parts = [part for part in re.split(r"[ /]", value) if part]
    if not parts:
        return value
    return parts[-1].replace("*.csv", "events")


def normalize_lineage_id(value: str) -> str:
    normalized_value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized_value or "lineage"
