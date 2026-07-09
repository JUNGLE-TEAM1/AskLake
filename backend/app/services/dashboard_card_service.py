from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import status
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.repositories.dashboard_card_repository import (
    delete_dashboard_card,
    get_dashboard_card,
    list_dashboard_cards,
    save_dashboard_card,
    split_dashboard_tags,
)
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    CreateDashboardRequest,
    DashboardCard,
    DashboardListFilterOptions,
    DashboardListQuery,
    DashboardListResponse,
    DashboardSortOption,
    UpdateDashboardRequest,
)


def _format_dashboard_timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M")


def _iso_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _dashboard_id() -> str:
    return f"dash_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{uuid4().hex[:8]}"


def _source_label(source: str) -> str:
    return {
        "catalog": "Catalog 생성",
        "manual": "수동 생성",
        "sql": "SQL 생성",
    }.get(source, "수동 생성")


def _date_value(value: str | None) -> float:
    if not value:
        return 0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def _sort_value(card: DashboardCard, sort: DashboardSortOption) -> tuple[object, str]:
    sort_value = sort.value if hasattr(sort, "value") else str(sort)
    if sort_value.startswith("name-"):
        return (card.name.casefold(), card.id)
    if sort_value.startswith("created-"):
        return (_date_value(card.created_at_value or card.created_at), card.id)
    return (_date_value(card.updated_at_value), card.id)


def _sort_dashboard_cards(cards: list[DashboardCard], sort: DashboardSortOption) -> list[DashboardCard]:
    sort_value = sort.value if hasattr(sort, "value") else str(sort)
    reverse = sort_value.endswith("-desc")
    return sorted(cards, key=lambda card: _sort_value(card, sort), reverse=reverse)


def _matches_query(card: DashboardCard, query: DashboardListQuery) -> bool:
    search = (query.search_query or query.search or "").strip().casefold()
    owner = (query.owner or "").strip()
    selected_tags = [tag.strip() for tag in query.tags if tag.strip()]
    card_tags = split_dashboard_tags(card.tags)

    if search and not any(search in value.casefold() for value in [card.name, card.owner, card.tags]):
        return False
    if owner and owner != "all" and card.owner != owner:
        return False
    if selected_tags and not all(tag in card_tags for tag in selected_tags):
        return False

    return True


def _filter_options(cards: list[DashboardCard]) -> DashboardListFilterOptions:
    owners = sorted({card.owner for card in cards if card.owner})
    tags = sorted({tag for card in cards for tag in split_dashboard_tags(card.tags)})
    return DashboardListFilterOptions(owners=owners, tags=tags)


def query_dashboard_cards(db: Session, query: DashboardListQuery) -> DashboardListResponse:
    source_cards = list_dashboard_cards(db)
    filtered_cards = [card for card in source_cards if _matches_query(card, query)]
    sorted_cards = _sort_dashboard_cards(filtered_cards, query.sort)
    page_size = query.page_size
    total = len(sorted_cards)
    max_page = max(1, (total + page_size - 1) // page_size)
    page = min(query.page, max_page)
    start_index = (page - 1) * page_size

    return DashboardListResponse(
        filterOptions=_filter_options(source_cards),
        items=sorted_cards[start_index : start_index + page_size],
        page=page,
        pageSize=page_size,
        total=total,
    )


def create_dashboard_card(db: Session, request: CreateDashboardRequest, actor_name: str) -> DashboardCard:
    created_at = datetime.now(timezone.utc)
    title = (request.title or "").strip() or f"새 대시보드 {_format_dashboard_timestamp(created_at)}"
    source = request.source.value if hasattr(request.source, "value") else str(request.source)
    owner = (request.owner or "").strip() or actor_name
    created_by = (actor_name or "").strip() or "Admin User"

    dashboard = DashboardCard(
        createdAt=_format_dashboard_timestamp(created_at),
        createdAtValue=_iso_timestamp(created_at),
        createdBy=created_by,
        createdByProfile=identity_profile(created_by),
        datasetId=request.dataset_id,
        hasPublishedRevision=False,
        id=_dashboard_id(),
        meta=f"0개 위젯 · {_source_label(source)}",
        name=title,
        owner=owner,
        sourceRunId=request.sql_run_id,
        status="draft",
        tags="초안 · Dashboard",
        updated="방금 전",
        updatedAtValue=_iso_timestamp(created_at),
        widgets=[],
    )
    save_dashboard_card(db, dashboard)
    db.commit()
    return dashboard


def identity_profile(name: str) -> dict[str, str]:
    display_name = (name or "").strip() or "Admin User"
    words = [word for word in display_name.replace("_", " ").replace("-", " ").split(" ") if word]
    initials = "".join(word[0].upper() for word in words[:2]) or display_name[:2].upper()
    return {
        "avatarInitials": initials[:2],
        "displayName": display_name,
    }


def update_dashboard_card_title(db: Session, dashboard_id: str, request: UpdateDashboardRequest) -> DashboardCard:
    title = request.title.strip()
    if not title:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "Dashboard title is required", status.HTTP_400_BAD_REQUEST)

    dashboard = get_dashboard_card(db, dashboard_id)
    if dashboard is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Dashboard not found", status.HTTP_404_NOT_FOUND)

    updated_at = datetime.now(timezone.utc)
    next_dashboard = dashboard.model_copy(
        update={
            "name": title,
            "updated": "방금 전",
            "updated_at_value": _iso_timestamp(updated_at),
        }
    )
    save_dashboard_card(db, next_dashboard)
    db.commit()
    return next_dashboard


def delete_dashboard_card_with_permission(
    db: Session,
    dashboard_id: str,
    actor_name: str,
    actor_role: str,
) -> str:
    dashboard = get_dashboard_card(db, dashboard_id)
    if dashboard is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Dashboard not found", status.HTTP_404_NOT_FOUND)

    if actor_role.lower() != "admin" and dashboard.owner != actor_name:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Only the dashboard owner or an admin can delete this dashboard",
            status.HTTP_403_FORBIDDEN,
        )

    DashboardRuntimeRepository(db).delete_dashboard_runtime(dashboard_id)
    delete_dashboard_card(db, dashboard_id)
    db.commit()
    return dashboard_id
