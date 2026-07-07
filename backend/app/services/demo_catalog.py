from typing import Any

from app.services.pair2_demo_data import PAIR2_COMMERCE_DATASETS

DEMO_JOBS: list[dict[str, Any]] = [
    {
        "id": "job_demo_logistics_gold",
        "name": "logistics_cost_gold_pipeline",
        "owner": "data-team-01",
        "tag": "[데모]",
        "source": "PostgreSQL / logistics_raw",
        "target": "gold_logistics_cost_overview",
        "schedule": "매일 09:00",
        "status": "scheduled",
        "lastRun": "초기화 후 준비됨",
        "lastState": "대기 중",
        "nextRun": "다음 예약 대기",
        "targetLayer": "GOLD",
        "targetFormat": "Parquet",
    }
]

DEMO_DATASETS: list[dict[str, Any]] = [
    {
        "description": "운송비, 창고비, 총 물류비를 월/지역/운송사 기준으로 집계한 골드 데이터셋",
        "downstream": ["SQL 분석", "대시보드"],
        "freshness": "latest",
        "id": "gold_logistics_cost_overview",
        "layer": "GOLD",
        "lastUpdated": "방금 전",
        "name": "Logistics Cost Overview",
        "nextRefresh": "매일 09:00",
        "owner": "data-team-01",
        "quality": "97%",
        "rag": False,
        "rows": "24 rows",
        "sampleRows": [
            ["2026-01", "KR", "FastShip", "4200000", "1350000", "5550000"],
            ["2026-02", "KR", "FastShip", "3840000", "1280000", "5120000"],
            ["2026-03", "JP", "OceanLink", "4620000", "1510000", "6130000"],
            ["2026-04", "SG", "AirBridge", "3180000", "940000", "4120000"],
        ],
        "schema": [
            ["month", "date"],
            ["region", "string"],
            ["carrier", "string"],
            ["transport_cost", "decimal"],
            ["warehouse_cost", "decimal"],
            ["total_cost", "decimal"],
        ],
        "size": "128KB",
        "source": "logistics_cost_gold_pipeline",
        "status": "available",
        "tags": ["#logistics", "#cost", "#gold"],
        "upstream": ["Lake shipment_cost_raw", "logistics_cost_gold_pipeline"],
    },
    {
        "description": "배송 리드타임, 정시 배송률, 배송 건수를 집계한 골드 데이터셋",
        "downstream": ["SQL 분석", "대시보드"],
        "freshness": "latest",
        "id": "gold_shipment_performance",
        "layer": "GOLD",
        "lastUpdated": "방금 전",
        "name": "Shipment Performance",
        "nextRefresh": "매일 09:00",
        "owner": "data-team-01",
        "quality": "96%",
        "rag": False,
        "rows": "36 rows",
        "sampleRows": [
            ["2026-07-01", "KR", "standard", "1280", "94.2", "2.8"],
            ["2026-07-01", "JP", "express", "720", "97.1", "1.4"],
            ["2026-07-02", "SG", "standard", "540", "92.8", "3.1"],
            ["2026-07-02", "AU", "express", "460", "95.5", "1.9"],
        ],
        "schema": [
            ["ship_date", "date"],
            ["destination_region", "string"],
            ["service_level", "string"],
            ["shipment_count", "integer"],
            ["on_time_rate", "decimal"],
            ["avg_lead_time_days", "decimal"],
        ],
        "size": "156KB",
        "source": "shipment_performance_gold_pipeline",
        "status": "available",
        "tags": ["#shipment", "#delivery", "#gold"],
        "upstream": ["Lake shipment_events", "shipment_performance_gold_pipeline"],
    },
    {
        "description": "창고별 재고 수량, 재고 금액, 품절 위험 수량을 집계한 골드 데이터셋",
        "downstream": ["SQL 분석", "대시보드"],
        "freshness": "latest",
        "id": "gold_inventory_status",
        "layer": "GOLD",
        "lastUpdated": "방금 전",
        "name": "Inventory Status",
        "nextRefresh": "매일 09:00",
        "owner": "data-team-01",
        "quality": "95%",
        "rag": False,
        "rows": "48 rows",
        "sampleRows": [
            ["2026-07-01", "Seoul DC", "electronics", "18420", "912000000", "18"],
            ["2026-07-01", "Busan DC", "home", "12600", "348000000", "11"],
            ["2026-07-02", "Tokyo DC", "beauty", "9200", "221000000", "7"],
            ["2026-07-02", "Singapore DC", "grocery", "15800", "184000000", "24"],
        ],
        "schema": [
            ["snapshot_date", "date"],
            ["warehouse", "string"],
            ["sku_category", "string"],
            ["stock_quantity", "integer"],
            ["inventory_value", "decimal"],
            ["stockout_risk_count", "integer"],
        ],
        "size": "192KB",
        "source": "inventory_status_gold_pipeline",
        "status": "available",
        "tags": ["#inventory", "#warehouse", "#gold"],
        "upstream": ["Lake inventory_snapshot", "inventory_status_gold_pipeline"],
    },
]

DEMO_DATASETS.extend(
    dataset for dataset in PAIR2_COMMERCE_DATASETS
    if not any(existing["id"] == dataset["id"] for existing in DEMO_DATASETS)
)


def get_demo_dataset(dataset_id: str | None) -> dict[str, Any] | None:
    if not dataset_id:
        return None
    return next((dataset for dataset in DEMO_DATASETS if dataset["id"] == dataset_id), None)


def dataset_rows_to_widget_data(dataset: dict[str, Any] | None, limit: int = 100) -> list[dict[str, Any]]:
    if dataset is None:
        return []

    rows = dataset.get("dataRows")
    if not isinstance(rows, list):
        rows = dataset.get("sampleRows")
    if not isinstance(rows, list):
        return []

    columns = _dataset_columns(dataset)
    widget_rows: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, list):
            record = _row_array_to_record(row, columns)
        elif _is_record(row):
            record = _row_record_to_snapshot(row, columns)
        else:
            record = None
        if record is not None:
            widget_rows.append(record)

    return widget_rows[:limit]


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _dataset_columns(dataset: dict[str, Any]) -> list[dict[str, str]]:
    schema = dataset.get("schema")
    if not isinstance(schema, list):
        return []

    columns: list[dict[str, str]] = []
    for index, entry in enumerate(schema):
        if not isinstance(entry, list) or not entry:
            continue
        name = entry[0]
        if not isinstance(name, str) or not name.strip():
            continue
        column_type = entry[1] if len(entry) > 1 and isinstance(entry[1], str) else ""
        columns.append({
            "fallbackName": f"column_{index + 1}",
            "name": name,
            "type": column_type,
        })
    return columns


def _row_array_to_record(row: list[Any], columns: list[dict[str, str]]) -> dict[str, Any]:
    record: dict[str, Any] = {}
    for index, value in enumerate(row):
        column = columns[index] if index < len(columns) else None
        key = column["name"] if column else f"column_{index + 1}"
        record[key] = _coerce_dataset_value(value, column["type"] if column else "")
    return record


def _row_record_to_snapshot(row: dict[str, Any], columns: list[dict[str, str]]) -> dict[str, Any]:
    record = dict(row)
    for column in columns:
        name = column["name"]
        if name in record:
            record[name] = _coerce_dataset_value(record[name], column["type"])
    return record


def _coerce_dataset_value(value: Any, column_type: str = "") -> Any:
    if value is None or value == "":
        return value

    normalized_type = column_type.lower()
    is_numeric_type = any(
        numeric_type in normalized_type
        for numeric_type in ["bigint", "decimal", "double", "float", "int", "number", "numeric", "real"]
    )
    if is_numeric_type:
        if isinstance(value, int | float):
            return value
        try:
            return float(str(value).replace(",", ""))
        except ValueError:
            return value

    if "bool" in normalized_type and isinstance(value, str):
        if value.lower() == "true":
            return True
        if value.lower() == "false":
            return False

    return value
