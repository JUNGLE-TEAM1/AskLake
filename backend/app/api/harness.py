from fastapi import APIRouter

router = APIRouter(prefix="/harness", tags=["harness"])


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
