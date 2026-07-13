from pathlib import Path
from typing import Any

import duckdb

from app.services.pair2_demo_data import PAIR2_COMMERCE_DATASETS

DEMO_JOBS: list[dict[str, Any]] = [
    {
        "id": "job_demo_commerce_channel_roi",
        "name": "commerce_channel_roi_gold_pipeline",
        "owner": "growth-analytics",
        "tag": "[데모]",
        "source": "SQL Result / commerce_orders_daily + commerce_marketing_spend_daily",
        "target": "gold_commerce_channel_roi",
        "schedule": "수동 실행",
        "status": "scheduled",
        "lastRun": "SQL 분석 결과 materialize 완료",
        "lastState": "대기 중",
        "nextRun": "-",
        "targetLayer": "GOLD",
        "targetFormat": "Parquet",
    },
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

COMMERCE_ORDERS_DATASET_ID = "ds_commerce_orders_daily"
COMMERCE_MARKETING_DATASET_ID = "ds_commerce_marketing_spend_daily"
COMMERCE_CHANNEL_ROI_DATASET_ID = "ds_gold_commerce_channel_roi"

COMMERCE_ORDERS_SCHEMA = [
    ["order_date", "date"],
    ["channel", "string"],
    ["category", "string"],
    ["orders", "integer"],
    ["gross_revenue", "decimal"],
    ["refund_amount", "decimal"],
    ["net_revenue", "decimal"],
    ["conversion_rate", "decimal"],
]
COMMERCE_MARKETING_SCHEMA = [
    ["spend_date", "date"],
    ["channel", "string"],
    ["campaign", "string"],
    ["impressions", "integer"],
    ["clicks", "integer"],
    ["ad_spend", "decimal"],
    ["cpc", "decimal"],
]
COMMERCE_CHANNEL_ROI_SCHEMA = [
    ["order_date", "date"],
    ["channel", "string"],
    ["category", "string"],
    ["net_revenue", "decimal"],
    ["ad_spend", "decimal"],
    ["roas", "decimal"],
    ["orders", "integer"],
    ["cost_per_order", "decimal"],
]

COMMERCE_CHANNEL_CONFIG = [
    {
        "adSpend": 1460000,
        "aov": 76000,
        "campaign": "brand_search_efficiency",
        "category": "electronics",
        "channel": "paid_search",
        "conversion": 4.7,
        "orders": 118,
        "refund": 0.032,
        "traffic": 18400,
    },
    {
        "adSpend": 980000,
        "aov": 52000,
        "campaign": "social_new_arrivals",
        "category": "beauty",
        "channel": "social",
        "conversion": 3.1,
        "orders": 96,
        "refund": 0.041,
        "traffic": 31600,
    },
    {
        "adSpend": 640000,
        "aov": 68000,
        "campaign": "crm_weekly_offer",
        "category": "home",
        "channel": "email",
        "conversion": 6.3,
        "orders": 84,
        "refund": 0.025,
        "traffic": 8200,
    },
    {
        "adSpend": 1180000,
        "aov": 41000,
        "campaign": "affiliate_summer_pick",
        "category": "sports",
        "channel": "affiliate",
        "conversion": 2.8,
        "orders": 142,
        "refund": 0.037,
        "traffic": 22400,
    },
]


def build_commerce_orders_rows() -> list[list[str]]:
    rows: list[list[str]] = []
    for day_index in range(15):
        order_date = f"2026-06-{day_index + 16:02d}"
        for channel_index, config in enumerate(COMMERCE_CHANNEL_CONFIG):
            orders = int(config["orders"]) + day_index * (5 + channel_index) + channel_index * 7
            gross_revenue = orders * int(config["aov"])
            refund_amount = round(gross_revenue * float(config["refund"]))
            net_revenue = gross_revenue - refund_amount
            conversion_rate = float(config["conversion"]) + day_index * 0.03 - channel_index * 0.04
            rows.append([
                order_date,
                str(config["channel"]),
                str(config["category"]),
                str(orders),
                str(gross_revenue),
                str(refund_amount),
                str(net_revenue),
                f"{conversion_rate:.2f}",
            ])
    return rows


def build_commerce_marketing_rows() -> list[list[str]]:
    rows: list[list[str]] = []
    for day_index in range(15):
        spend_date = f"2026-06-{day_index + 16:02d}"
        for channel_index, config in enumerate(COMMERCE_CHANNEL_CONFIG):
            impressions = int(config["traffic"]) + day_index * (480 + channel_index * 70)
            clicks = round(impressions * (0.045 + channel_index * 0.006))
            ad_spend = int(config["adSpend"]) + day_index * (42000 + channel_index * 8500)
            cpc = ad_spend / max(clicks, 1)
            rows.append([
                spend_date,
                str(config["channel"]),
                str(config["campaign"]),
                str(impressions),
                str(clicks),
                str(ad_spend),
                f"{cpc:.2f}",
            ])
    return rows


def build_commerce_channel_roi_rows() -> list[list[str]]:
    rows: list[list[str]] = []
    order_rows = build_commerce_orders_rows()
    marketing_rows = build_commerce_marketing_rows()
    for order_row, marketing_row in zip(order_rows, marketing_rows, strict=True):
        net_revenue = int(order_row[6])
        orders = int(order_row[3])
        ad_spend = int(marketing_row[5])
        rows.append([
            order_row[0],
            order_row[1],
            order_row[2],
            str(net_revenue),
            str(ad_spend),
            f"{net_revenue / ad_spend:.2f}",
            str(orders),
            f"{ad_spend / max(orders, 1):.2f}",
        ])
    return rows


def lineage_columns(dataset_id: str, schema: list[list[str]]) -> list[dict[str, str]]:
    return [
        {
            "id": f"{dataset_id}-{column_name}".replace("_", "-"),
            "name": column_name,
            "type": column_type,
        }
        for column_name, column_type in schema
    ]


def simple_lineage_graph(
    *,
    dataset_id: str,
    source_name: str,
    source_node_id: str,
    target_name: str,
    schema: list[list[str]],
) -> dict[str, Any]:
    source_columns = lineage_columns(source_node_id, schema)
    target_columns = lineage_columns(dataset_id, schema)
    return {
        "datasetId": dataset_id,
        "datasets": [
            {
                "columns": source_columns,
                "engine": "POSTGRESQL",
                "id": source_node_id,
                "layer": "SOURCE",
                "name": source_name,
            },
            {
                "columns": target_columns,
                "engine": "ICEBERG",
                "id": dataset_id,
                "layer": "GOLD",
                "name": target_name,
            },
        ],
        "edges": [
            {
                "fromColumnId": source_columns[index]["id"],
                "fromDatasetId": source_node_id,
                "toColumnId": target_columns[index]["id"],
                "toDatasetId": dataset_id,
            }
            for index in range(len(target_columns))
        ],
    }


def commerce_channel_roi_lineage_graph() -> dict[str, Any]:
    orders_columns = lineage_columns(COMMERCE_ORDERS_DATASET_ID, COMMERCE_ORDERS_SCHEMA)
    marketing_columns = lineage_columns(COMMERCE_MARKETING_DATASET_ID, COMMERCE_MARKETING_SCHEMA)
    target_columns = lineage_columns(COMMERCE_CHANNEL_ROI_DATASET_ID, COMMERCE_CHANNEL_ROI_SCHEMA)
    orders_by_name = {column["name"]: column for column in orders_columns}
    marketing_by_name = {column["name"]: column for column in marketing_columns}
    target_by_name = {column["name"]: column for column in target_columns}

    def edge(source: dict[str, str], target_name: str, source_dataset_id: str) -> dict[str, str]:
        return {
            "fromColumnId": source["id"],
            "fromDatasetId": source_dataset_id,
            "toColumnId": target_by_name[target_name]["id"],
            "toDatasetId": COMMERCE_CHANNEL_ROI_DATASET_ID,
        }

    return {
        "datasetId": COMMERCE_CHANNEL_ROI_DATASET_ID,
        "datasets": [
            {
                "columns": orders_columns,
                "engine": "ICEBERG",
                "id": COMMERCE_ORDERS_DATASET_ID,
                "layer": "SILVER",
                "name": "commerce_orders_daily",
            },
            {
                "columns": marketing_columns,
                "engine": "ICEBERG",
                "id": COMMERCE_MARKETING_DATASET_ID,
                "layer": "SILVER",
                "name": "commerce_marketing_spend_daily",
            },
            {
                "columns": target_columns,
                "engine": "ICEBERG",
                "id": COMMERCE_CHANNEL_ROI_DATASET_ID,
                "layer": "GOLD",
                "name": "gold_commerce_channel_roi",
            },
        ],
        "edges": [
            edge(orders_by_name["order_date"], "order_date", COMMERCE_ORDERS_DATASET_ID),
            edge(marketing_by_name["spend_date"], "order_date", COMMERCE_MARKETING_DATASET_ID),
            edge(orders_by_name["channel"], "channel", COMMERCE_ORDERS_DATASET_ID),
            edge(marketing_by_name["channel"], "channel", COMMERCE_MARKETING_DATASET_ID),
            edge(orders_by_name["category"], "category", COMMERCE_ORDERS_DATASET_ID),
            edge(orders_by_name["net_revenue"], "net_revenue", COMMERCE_ORDERS_DATASET_ID),
            edge(marketing_by_name["ad_spend"], "ad_spend", COMMERCE_MARKETING_DATASET_ID),
            edge(orders_by_name["net_revenue"], "roas", COMMERCE_ORDERS_DATASET_ID),
            edge(marketing_by_name["ad_spend"], "roas", COMMERCE_MARKETING_DATASET_ID),
            edge(orders_by_name["orders"], "orders", COMMERCE_ORDERS_DATASET_ID),
            edge(marketing_by_name["ad_spend"], "cost_per_order", COMMERCE_MARKETING_DATASET_ID),
            edge(orders_by_name["orders"], "cost_per_order", COMMERCE_ORDERS_DATASET_ID),
        ],
    }


COMMERCE_DEMO_DATASETS: list[dict[str, Any]] = [
    {
        "description": "채널/카테고리/일자 기준 주문 수, 순매출, 환불 금액을 담은 커머스 주문 분석 원본 데이터셋",
        "downstream": ["SQL 분석", "gold_commerce_channel_roi"],
        "freshness": "latest",
        "id": COMMERCE_ORDERS_DATASET_ID,
        "layer": "SILVER",
        "lastUpdated": "2026-06-30T23:40:00.000Z",
        "lineageGraph": simple_lineage_graph(
            dataset_id=COMMERCE_ORDERS_DATASET_ID,
            source_name="PostgreSQL commerce.orders_daily",
            source_node_id="source-commerce-orders-daily",
            target_name="commerce_orders_daily",
            schema=COMMERCE_ORDERS_SCHEMA,
        ),
        "name": "commerce_orders_daily",
        "nextRefresh": "매일 00:10",
        "owner": "growth-analytics",
        "quality": "98% (Demo verified)",
        "rag": False,
        "rows": "32,400 rows",
        "sampleRows": build_commerce_orders_rows(),
        "schema": COMMERCE_ORDERS_SCHEMA,
        "size": "1.4MB",
        "source": "commerce_orders_daily_ingest",
        "status": "available",
        "tags": ["#commerce", "#orders", "#silver", "#demo"],
        "upstream": ["PostgreSQL commerce.orders_daily", "commerce_orders_daily_ingest"],
    },
    {
        "description": "채널/캠페인/일자 기준 노출, 클릭, 광고비를 담은 커머스 마케팅 비용 원본 데이터셋",
        "downstream": ["SQL 분석", "gold_commerce_channel_roi"],
        "freshness": "latest",
        "id": COMMERCE_MARKETING_DATASET_ID,
        "layer": "SILVER",
        "lastUpdated": "2026-06-30T23:45:00.000Z",
        "lineageGraph": simple_lineage_graph(
            dataset_id=COMMERCE_MARKETING_DATASET_ID,
            source_name="PostgreSQL marketing.channel_spend_daily",
            source_node_id="source-marketing-channel-spend-daily",
            target_name="commerce_marketing_spend_daily",
            schema=COMMERCE_MARKETING_SCHEMA,
        ),
        "name": "commerce_marketing_spend_daily",
        "nextRefresh": "매일 00:20",
        "owner": "growth-analytics",
        "quality": "97% (Demo verified)",
        "rag": False,
        "rows": "2,160 rows",
        "sampleRows": build_commerce_marketing_rows(),
        "schema": COMMERCE_MARKETING_SCHEMA,
        "size": "720KB",
        "source": "commerce_marketing_spend_ingest",
        "status": "available",
        "tags": ["#commerce", "#marketing", "#silver", "#demo"],
        "upstream": ["PostgreSQL marketing.channel_spend_daily", "commerce_marketing_spend_ingest"],
    },
    {
        "description": "주문 데이터와 마케팅 비용 데이터를 일자+채널 기준으로 조인해 만든 채널별 ROAS/주문당 비용 분석 골드 데이터셋",
        "downstream": ["SQL 분석", "대시보드", "Growth weekly business review"],
        "freshness": "latest",
        "id": COMMERCE_CHANNEL_ROI_DATASET_ID,
        "layer": "GOLD",
        "lastUpdated": "2026-06-30T23:55:00.000Z",
        "lineageGraph": commerce_channel_roi_lineage_graph(),
        "name": "gold_commerce_channel_roi",
        "nextRefresh": "수동 갱신",
        "owner": "growth-analytics",
        "quality": "SQL Preview verified",
        "rag": False,
        "rows": "1,080 rows",
        "sampleRows": build_commerce_channel_roi_rows(),
        "schema": COMMERCE_CHANNEL_ROI_SCHEMA,
        "size": "1.1MB",
        "source": "commerce_channel_roi_gold_pipeline",
        "sourceRunId": "sql_demo_commerce_channel_roi",
        "status": "available",
        "storageFormat": "parquet",
        "storageLocation": "s3a://asklake-demo/gold/commerce_channel_roi/",
        "storageSizeBytes": 1146880,
        "tags": ["#commerce", "#marketing", "#roi", "#gold", "#demo"],
        "upstream": [
            "commerce_orders_daily",
            "commerce_marketing_spend_daily",
            "SQL: orders.order_date = spend.spend_date AND orders.channel = spend.channel",
        ],
    },
]

DEMO_DATASETS: list[dict[str, Any]] = [
    *COMMERCE_DEMO_DATASETS,
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


def dataset_rows_to_widget_data(
    dataset: dict[str, Any] | None,
    limit: int = 100,
    *,
    prefer_storage: bool = True,
) -> list[dict[str, Any]]:
    if dataset is None:
        return []

    if prefer_storage:
        storage_rows = _storage_rows_to_widget_data(dataset, limit)
        if storage_rows:
            return storage_rows

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


def _storage_rows_to_widget_data(dataset: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    storage_format = str(dataset.get("storageFormat") or dataset.get("storage_format") or "").lower()
    storage_location = dataset.get("storageLocation") or dataset.get("storage_location")
    if storage_format != "parquet" or not storage_location:
        return []

    storage_path = Path(str(storage_location))
    if not storage_path.exists():
        return []

    parquet_path = _parquet_scan_path(storage_path)
    if not parquet_path:
        return []

    connection = duckdb.connect(database=":memory:")
    try:
        cursor = connection.execute(
            "SELECT * FROM read_parquet(?) LIMIT ?",
            [parquet_path, limit],
        )
        columns = [str(description[0]) for description in (cursor.description or [])]
        return [
            {
                column_name: _format_storage_cell(row[column_index])
                for column_index, column_name in enumerate(columns)
            }
            for row in cursor.fetchall()
        ]
    except duckdb.Error:
        return []
    finally:
        connection.close()


def _parquet_scan_path(storage_path: Path) -> str:
    if storage_path.is_file() and storage_path.suffix.lower() == ".parquet":
        return str(storage_path)
    if storage_path.is_dir() and list(storage_path.rglob("*.parquet")):
        return str(storage_path / "**" / "*.parquet")
    return ""


def _format_storage_cell(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


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
