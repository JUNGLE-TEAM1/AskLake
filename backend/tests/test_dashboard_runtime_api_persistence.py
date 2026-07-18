import os

import pytest
from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext, get_actor_context
from app.main import create_app


pytestmark = pytest.mark.skipif(
    os.getenv("ASKLAKE_RUN_POSTGRES_INTEGRATION") != "1",
    reason="requires the local AskLake PostgreSQL integration service",
)


def test_chart_create_update_publish_and_runtime_round_trip_through_api() -> None:
    app = create_app()
    app.dependency_overrides[get_actor_context] = lambda: ActorContext(
        name="dashboard-api-harness",
        role="admin",
    )
    dashboard_id: str | None = None

    try:
        with TestClient(app) as client:
            try:
                existing = client.get("/api/dashboards", params={"pageSize": 100})
                assert existing.status_code == 200, existing.text
                for dashboard in existing.json()["items"]:
                    if (
                        dashboard["name"] == "API persistence harness"
                        and dashboard["owner"] == "dashboard-api-harness"
                    ):
                        stale_cleanup = client.delete(f"/api/dashboards/{dashboard['id']}")
                        assert stale_cleanup.status_code == 200, stale_cleanup.text

                created = client.post(
                    "/api/dashboards",
                    json={"source": "manual", "title": "API persistence harness"},
                )
                assert created.status_code == 201, created.text
                dashboard_id = created.json()["dashboard"]["id"]

                draft = client.post(f"/api/dashboards/{dashboard_id}/draft/ensure")
                assert draft.status_code == 200, draft.text
                page_id = draft.json()["pages"][0]["id"]

                created_widget = client.post(
                    f"/api/dashboards/{dashboard_id}/draft/pages/{page_id}/widgets",
                    json={
                        "config": {
                            "aggregation": "sum",
                            "color": {"colors": ["#2563eb"]},
                            "xKey": "region",
                            "yKey": "revenue",
                        },
                        "data": [
                            {"region": "서울", "revenue": 120},
                            {"region": "부산", "revenue": 80},
                        ],
                        "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
                        "title": "지역별 매출",
                        "type": "bar_chart",
                    },
                )
                assert created_widget.status_code == 200, created_widget.text
                widget_id = created_widget.json()["id"]

                updated_widget = client.patch(
                    f"/api/dashboards/{dashboard_id}/draft/widgets/{widget_id}",
                    json={
                        "config": {
                            "aggregation": "sum",
                            "color": {"colors": ["#ef4444"]},
                            "xKey": "region",
                            "yKey": "revenue",
                        },
                        "data": [
                            {"region": "서울", "revenue": 150},
                            {"region": "부산", "revenue": 90},
                        ],
                        "title": "지역별 확정 매출",
                        "type": "bar_chart",
                    },
                )
                assert updated_widget.status_code == 200, updated_widget.text

                reconciled_draft = client.post(f"/api/dashboards/{dashboard_id}/draft/ensure")
                assert reconciled_draft.status_code == 200, reconciled_draft.text
                draft_payload = reconciled_draft.json()
                draft_chart = draft_payload["widgetsByPageId"][page_id][0]
                assert draft_chart["id"] == widget_id
                assert draft_chart["title"] == "지역별 확정 매출"
                assert draft_chart["config"]["color"]["colors"] == ["#ef4444"]
                assert draft_chart["data"] == [
                    {"region": "서울", "revenue": 150},
                    {"region": "부산", "revenue": 90},
                ]

                published = client.post(f"/api/dashboards/{dashboard_id}/publish")
                assert published.status_code == 200, published.text
                assert published.json()["dashboardId"] == dashboard_id

                runtime = client.get(f"/api/dashboards/{dashboard_id}/published")
                assert runtime.status_code == 200, runtime.text
                runtime_payload = runtime.json()
                published_page_id = runtime_payload["pages"][0]["id"]
                runtime_chart = runtime_payload["widgetsByPageId"][published_page_id][0]
                assert runtime_chart["title"] == "지역별 확정 매출"
                assert runtime_chart["type"] == "bar_chart"
                assert runtime_chart["config"]["xKey"] == "region"
                assert runtime_chart["config"]["yKey"] == "revenue"
                assert runtime_chart["data"] == [
                    {"region": "서울", "revenue": 150},
                    {"region": "부산", "revenue": 90},
                ]
            finally:
                if dashboard_id is not None:
                    cleanup = client.delete(f"/api/dashboards/{dashboard_id}")
                    assert cleanup.status_code == 200, cleanup.text
    finally:
        app.dependency_overrides.clear()
