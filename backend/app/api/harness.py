from fastapi import APIRouter, Depends, status

from app.core.config import settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode


def require_local_harness_mode() -> None:
    if not settings.allows_header_auth_fallback:
        raise ApiError(ErrorCode.NOT_FOUND, "Harness endpoints are not available", status.HTTP_404_NOT_FOUND)


router = APIRouter(
    prefix="/harness",
    tags=["harness"],
    dependencies=[Depends(require_local_harness_mode)],
)


@router.get("/rest-sample")
def get_rest_sample() -> dict[str, list[dict[str, object]]]:
    return {
        "data": [
            {
                "active": True,
                "amount": 42.7,
                "event_time": "2026-07-04T10:00:00Z",
                "id": 1,
                "payload": {"region": "KR"},
                "user_id": "u_001",
            },
            {
                "active": False,
                "amount": 19.25,
                "event_time": "2026-07-04T10:01:00Z",
                "id": 2,
                "payload": {"region": "US"},
                "user_id": "u_002",
            },
        ],
    }
