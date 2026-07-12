from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.etl_service import etl_dataset_lineage_graph


job = SimpleNamespace(
    id="JOB-LOG-LINEAGE",
    name="event_log_pipeline",
    schema_columns=[
        {"included": True, "sourceName": "event_id", "targetName": "event_key", "type": "String"},
        {"included": True, "sourceName": "event_type", "targetName": "event_type", "type": "String"},
    ],
    source_label="events.parquet",
    source_type="File / S3",
    target="event_gold",
    target_format="csv",
    target_layer="GOLD",
    transform_steps=[
        {"enabled": True, "input": "event_id", "output": "event_key"},
    ],
)

graph = etl_dataset_lineage_graph(
    job,
    "ds_event_gold",
    [
        ["event_key", "string"],
        ["event_type", "string"],
        ["_asklake_run_id", "string"],
    ],
)

source, pipeline, target = graph["datasets"]
assert [column["name"] for column in source["columns"]] == ["event_id", "event_type"]
assert source["layer"] == "SOURCE"
assert source["engine"] == "PARQUET"
assert pipeline["layer"] == "PROCESS"
assert pipeline["engine"] == "SPARK"
assert target["layer"] == "GOLD"
assert target["engine"] == "CSV"

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

assert (source["id"], "event_id", pipeline["id"], "event_key") in edge_names
assert (source["id"], "event_type", pipeline["id"], "event_type") in edge_names
assert not any(edge[0] == source["id"] and edge[3] == "_asklake_run_id" for edge in edge_names)
assert (pipeline["id"], "_asklake_run_id", target["id"], "_asklake_run_id") in edge_names

print("verify-etl-lineage: ok")
