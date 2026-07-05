import re

from fastapi import status

from app.core.errors import ApiError
from app.repositories.catalog_repository import CatalogRepository
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


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self.repository = repository

    def list_datasets(self) -> CatalogDatasetListResponse:
        datasets = [
            CatalogDatasetResponse.model_validate(model.payload)
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

    def create_derived_dataset(self, _: CreateDerivedDatasetRequest) -> CatalogDatasetResponse:
        raise NotImplementedError(
            "Derived dataset persistence will be implemented in the Pair2 derived dataset API PR."
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
            for name, column_type in dataset.schema
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
