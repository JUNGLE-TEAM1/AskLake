from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.dashboard import (
    CreateDashboardRequest,
    DashboardCardResponse,
    DashboardListQuery,
    DashboardListResponse,
    DashboardSortOption,
    DeleteDashboardResponse,
    UpdateDashboardRequest,
)
from app.services.dashboard_card_service import (
    create_dashboard_card,
    delete_dashboard_card_with_permission,
    query_dashboard_cards,
    update_dashboard_card_title,
)

router = APIRouter(prefix="/dashboards", tags=["dashboard-card"])


@router.get("", response_model=DashboardListResponse)
def list_dashboards(
    search: str | None = None,
    owner: str | None = None,
    tags: str | None = None,
    sort: DashboardSortOption = DashboardSortOption.UPDATED_DESC,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, alias="pageSize", ge=1, le=100),
    db: Session = Depends(get_db),
) -> DashboardListResponse:
    query = DashboardListQuery(
        owner=owner,
        page=page,
        pageSize=page_size,
        search=search,
        sort=sort,
        tags=[tag.strip() for tag in (tags or "").split(",") if tag.strip()],
    )
    return query_dashboard_cards(db, query)


@router.post("/query", response_model=DashboardListResponse)
def query_dashboards(
    query: DashboardListQuery,
    db: Session = Depends(get_db),
) -> DashboardListResponse:
    return query_dashboard_cards(db, query)


@router.post("", response_model=DashboardCardResponse, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    request: CreateDashboardRequest,
    db: Session = Depends(get_db),
    actor_name: str = Header(default="Admin User", alias="X-AskLake-User"),
) -> DashboardCardResponse:
    return DashboardCardResponse(dashboard=create_dashboard_card(db, request, actor_name))


@router.patch("/{dashboard_id}", response_model=DashboardCardResponse)
def update_dashboard_title(
    dashboard_id: str,
    request: UpdateDashboardRequest,
    db: Session = Depends(get_db),
) -> DashboardCardResponse:
    return DashboardCardResponse(dashboard=update_dashboard_card_title(db, dashboard_id, request))


@router.delete("/{dashboard_id}", response_model=DeleteDashboardResponse)
def delete_dashboard(
    dashboard_id: str,
    db: Session = Depends(get_db),
    actor_name: str = Header(default="Admin User", alias="X-AskLake-User"),
    actor_role: str = Header(default="admin", alias="X-AskLake-Role"),
) -> DeleteDashboardResponse:
    deleted_dashboard_id = delete_dashboard_card_with_permission(db, dashboard_id, actor_name, actor_role)
    return DeleteDashboardResponse(deletedDashboardId=deleted_dashboard_id)
