from app import models as _models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.models.base import Base
from app.repositories.catalog_repository import CatalogRepository
from app.services.pair2_demo_data import (
    PAIR2_COMMERCE_DATASETS,
    PAIR2_LEGACY_ORDERS_DATASET_ID,
    build_legacy_orders_dataset_payload,
)


def seed_pair2_demo() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        repository = CatalogRepository(session)
        for dataset_payload in PAIR2_COMMERCE_DATASETS:
            repository.save_dataset_payload(dataset_payload)
        if repository.get_dataset_payload(PAIR2_LEGACY_ORDERS_DATASET_ID) is not None:
            repository.save_dataset_payload(build_legacy_orders_dataset_payload())
    print(f"Pair2 FastAPI demo datasets seeded: {len(PAIR2_COMMERCE_DATASETS)}")


if __name__ == "__main__":
    seed_pair2_demo()
