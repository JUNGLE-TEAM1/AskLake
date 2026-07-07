from app import models as _models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.models.base import Base
from app.repositories.catalog_repository import CatalogRepository


PAIR2_SEED_DATASET_ID = "ds_orders_clean"


PAIR2_SEED_DATASET_PAYLOAD = {
    "description": "전체 채널 통합 고객 주문 정제 데이터",
    "downstream": ["SQL 분석", "매출 대시보드"],
    "freshness": "latest",
    "id": PAIR2_SEED_DATASET_ID,
    "layer": "GOLD",
    "lastUpdated": "2026-07-03T00:03:00.000Z",
    "lineageGraph": {
        "datasetId": PAIR2_SEED_DATASET_ID,
        "datasets": [
            {
                "columns": [
                    {"id": "source-order-id", "name": "order_id", "type": "string"},
                    {"id": "source-customer-id", "name": "customer_id", "type": "string"},
                    {"id": "source-order-date", "name": "order_date", "type": "timestamp"},
                    {"id": "source-total-amount", "name": "total_amount", "type": "decimal"},
                    {"id": "source-status", "name": "status", "type": "string"},
                ],
                "engine": "POSTGRESQL",
                "id": "source-commerce-orders",
                "layer": "SOURCE",
                "name": "commerce.orders",
            },
            {
                "columns": [
                    {"id": "ds-orders-clean-order-id", "name": "order_id", "type": "string"},
                    {"id": "ds-orders-clean-customer-id", "name": "customer_id", "type": "string"},
                    {"id": "ds-orders-clean-order-date", "name": "order_date", "type": "timestamp"},
                    {"id": "ds-orders-clean-total-amount", "name": "total_amount", "type": "decimal"},
                    {"id": "ds-orders-clean-status", "name": "status", "type": "string"},
                ],
                "engine": "ICEBERG",
                "id": PAIR2_SEED_DATASET_ID,
                "layer": "GOLD",
                "name": "orders_clean",
            },
        ],
        "edges": [
            {
                "fromColumnId": "source-order-id",
                "fromDatasetId": "source-commerce-orders",
                "toColumnId": "ds-orders-clean-order-id",
                "toDatasetId": PAIR2_SEED_DATASET_ID,
            },
            {
                "fromColumnId": "source-customer-id",
                "fromDatasetId": "source-commerce-orders",
                "toColumnId": "ds-orders-clean-customer-id",
                "toDatasetId": PAIR2_SEED_DATASET_ID,
            },
            {
                "fromColumnId": "source-order-date",
                "fromDatasetId": "source-commerce-orders",
                "toColumnId": "ds-orders-clean-order-date",
                "toDatasetId": PAIR2_SEED_DATASET_ID,
            },
            {
                "fromColumnId": "source-total-amount",
                "fromDatasetId": "source-commerce-orders",
                "toColumnId": "ds-orders-clean-total-amount",
                "toDatasetId": PAIR2_SEED_DATASET_ID,
            },
            {
                "fromColumnId": "source-status",
                "fromDatasetId": "source-commerce-orders",
                "toColumnId": "ds-orders-clean-status",
                "toDatasetId": PAIR2_SEED_DATASET_ID,
            },
        ],
    },
    "name": "orders_clean",
    "nextRefresh": "2026-07-04 00:00",
    "owner": "Data Platform Team",
    "quality": "98% (Excellent)",
    "rag": True,
    "rows": "12.4M rows",
    "sampleRows": [
        ["ORD-1001", "CUS-204", "2026-07-02", "128000", "paid"],
        ["ORD-1002", "CUS-118", "2026-07-02", "56000", "shipped"],
        ["ORD-1003", "CUS-204", "2026-07-03", "91000", "paid"],
        ["ORD-1004", "CUS-311", "2026-07-03", "43000", "refunded"],
        ["ORD-1005", "CUS-407", "2026-07-04", "212000", "paid"],
        ["ORD-1006", "CUS-118", "2026-07-04", "78000", "paid"],
        ["ORD-1007", "CUS-522", "2026-07-05", "154000", "processing"],
        ["ORD-1008", "CUS-204", "2026-07-05", "32000", "canceled"],
        ["ORD-1009", "CUS-311", "2026-07-06", "187000", "shipped"],
        ["ORD-1010", "CUS-640", "2026-07-06", "99000", "paid"],
    ],
    "schema": [
        ["order_id", "string"],
        ["customer_id", "string"],
        ["order_date", "timestamp"],
        ["total_amount", "decimal"],
        ["status", "string"],
    ],
    "size": "18.2GB",
    "source": "daily_order_ingestion",
    "status": "available",
    "tags": ["#customer", "#sales", "#고객 주문"],
    "upstream": ["PostgreSQL commerce.orders", "daily_order_ingestion"],
}


def seed_pair2_demo() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        CatalogRepository(session).save_dataset_payload(PAIR2_SEED_DATASET_PAYLOAD)
    print(f"Pair2 FastAPI demo dataset seeded: {PAIR2_SEED_DATASET_ID}")


if __name__ == "__main__":
    seed_pair2_demo()
