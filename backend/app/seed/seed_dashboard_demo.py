from app import models as _models  # noqa: F401
from app.core.database import SessionLocal, engine
from app.models.base import Base
from app.repositories.catalog_repository import CatalogRepository
from app.services.demo_catalog import DEMO_DATASETS


def seed_dashboard_demo() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        repository = CatalogRepository(session)
        for dataset in DEMO_DATASETS:
            repository.save_dataset_payload(dataset)
    print(f"Dashboard demo catalog datasets seeded: {len(DEMO_DATASETS)}")


if __name__ == "__main__":
    seed_dashboard_demo()
