from fastapi import APIRouter, Depends, status

from app.core.config import settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.services.demo_catalog import DEMO_DATASETS, DEMO_JOBS


def require_local_demo_mode() -> None:
    if not settings.allows_header_auth_fallback:
        raise ApiError(ErrorCode.NOT_FOUND, "Demo hydration is not available", status.HTTP_404_NOT_FOUND)


router = APIRouter(tags=["demo-hydration"], dependencies=[Depends(require_local_demo_mode)])


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
