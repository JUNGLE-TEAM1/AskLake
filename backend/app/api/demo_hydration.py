from fastapi import APIRouter

from app.services.demo_catalog import DEMO_DATASETS, DEMO_JOBS

router = APIRouter(tags=["demo-hydration"])


@router.get("/etl/jobs")
def list_demo_jobs() -> dict[str, object]:
    return {
        "jobs": DEMO_JOBS,
        "page": {
            "cursor": None,
            "hasNext": False,
        },
    }


@router.get("/catalog/datasets")
def list_demo_catalog_datasets() -> dict[str, object]:
    return {
        "datasets": DEMO_DATASETS,
        "page": {
            "cursor": None,
            "hasNext": False,
        },
    }
