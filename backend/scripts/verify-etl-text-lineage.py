from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.etl_service import etl_dataset_lineage_graph


job = SimpleNamespace(
    id="JOB-TEXT-LINEAGE",
    name="text_lineage_pipeline",
    schema_columns=[
        {"included": True, "sourceName": "__text_analysis.text", "targetName": "text", "type": "String"},
        {"included": True, "sourceName": "__text_analysis.sentiment", "targetName": "sentiment", "type": "String"},
        {"included": True, "sourceName": "__text_analysis.severity", "targetName": "severity", "type": "String"},
    ],
    source_label="reviews.parquet",
    source_type="File / S3",
    target="review_gold",
    target_format="Parquet",
    target_layer="GOLD",
    transform_steps=[
        {"enabled": True, "input": "text", "output": "text"},
        {"enabled": True, "input": "text", "output": "sentiment"},
        {"enabled": True, "input": "text", "output": "severity"},
    ],
)

graph = etl_dataset_lineage_graph(
    job,
    "ds_review_gold",
    [
        ["text", "string"],
        ["sentiment", "string"],
        ["severity", "string"],
        ["_asklake_run_id", "string"],
    ],
)

source, pipeline, target = graph["datasets"]
assert [column["name"] for column in source["columns"]] == ["text"]
assert source["layer"] == "SOURCE"
assert source["engine"] == "PARQUET"
assert pipeline["layer"] == "PROCESS"
assert pipeline["engine"] == "SPARK"
assert target["layer"] == "GOLD"
assert target["engine"] == "PARQUET"

columns_by_id = {
    column["id"]: column["name"]
    for dataset in graph["datasets"]
    for column in dataset["columns"]
}
edge_names = {
    (
        edge["fromDatasetId"],
        columns_by_id[edge["fromColumnId"]],
        edge["toDatasetId"],
        columns_by_id[edge["toColumnId"]],
    )
    for edge in graph["edges"]
}

assert (source["id"], "text", pipeline["id"], "text") in edge_names
assert (source["id"], "text", pipeline["id"], "sentiment") in edge_names
assert (source["id"], "text", pipeline["id"], "severity") in edge_names
assert not any(edge[0] == source["id"] and edge[3] == "_asklake_run_id" for edge in edge_names)
assert (pipeline["id"], "_asklake_run_id", target["id"], "_asklake_run_id") in edge_names

print("verify-etl-text-lineage: ok")
