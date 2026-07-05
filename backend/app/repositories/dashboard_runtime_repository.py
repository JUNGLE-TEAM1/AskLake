from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from app.models.dashboard_runtime import DashboardPage, DashboardRevision, DashboardWidget
from app.schemas.dashboard import DashboardRuntimeMode, DashboardStatus


@dataclass(frozen=True)
class DashboardRuntimeMetaRecord:
    id: str
    title: str
    status: DashboardStatus
    has_published_revision: bool
    published_revision_id: str | None
    updated_at: datetime


class DashboardRuntimeRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_dashboard_meta(self, dashboard_id: str) -> DashboardRuntimeMetaRecord | None:
        if self._dashboards_table_exists():
            return self._get_dashboard_meta_from_card_list_table(dashboard_id)
        return self._mock_dashboard_meta(dashboard_id)

    def get_published_revision(self, dashboard_id: str) -> DashboardRevision | None:
        return self._get_revision_by_kind(dashboard_id, DashboardRuntimeMode.PUBLISHED)

    def get_draft_revision(self, dashboard_id: str) -> DashboardRevision | None:
        return self._get_revision_by_kind(dashboard_id, DashboardRuntimeMode.DRAFT)

    def list_pages(self, revision_id: str) -> list[DashboardPage]:
        statement = (
            select(DashboardPage)
            .where(DashboardPage.revision_id == revision_id)
            .order_by(DashboardPage.order_index.asc(), DashboardPage.created_at.asc())
        )
        return list(self.db.scalars(statement).all())

    def list_widgets_by_page_ids(self, page_ids: list[str]) -> dict[str, list[DashboardWidget]]:
        if not page_ids:
            return {}

        statement = (
            select(DashboardWidget)
            .where(DashboardWidget.page_id.in_(page_ids))
            .order_by(DashboardWidget.created_at.asc())
        )
        widgets_by_page_id = {page_id: [] for page_id in page_ids}
        for widget in self.db.scalars(statement).all():
            widgets_by_page_id.setdefault(widget.page_id, []).append(widget)
        return widgets_by_page_id

    def _get_revision_by_kind(self, dashboard_id: str, kind: DashboardRuntimeMode) -> DashboardRevision | None:
        statement = (
            select(DashboardRevision)
            .where(
                DashboardRevision.dashboard_id == dashboard_id,
                DashboardRevision.kind == kind.value,
            )
            .order_by(DashboardRevision.version.desc(), DashboardRevision.created_at.desc())
            .limit(1)
        )
        return self.db.scalars(statement).first()

    def _dashboards_table_exists(self) -> bool:
        bind = self.db.get_bind()
        return inspect(bind).has_table("dashboards")

    def _get_dashboard_meta_from_card_list_table(self, dashboard_id: str) -> DashboardRuntimeMetaRecord | None:
        row = self.db.execute(
            text(
                """
                SELECT
                    id,
                    name,
                    status,
                    has_published_revision,
                    published_revision_id,
                    updated_at
                FROM dashboards
                WHERE id = :dashboard_id
                """
            ),
            {"dashboard_id": dashboard_id},
        ).mappings().first()
        if row is None:
            return None

        return DashboardRuntimeMetaRecord(
            id=str(row["id"]),
            title=str(row["name"]),
            status=DashboardStatus(row["status"] or DashboardStatus.DRAFT.value),
            has_published_revision=bool(row["has_published_revision"]),
            published_revision_id=self._optional_str(row["published_revision_id"]),
            updated_at=self._coerce_datetime(row["updated_at"]),
        )

    def _mock_dashboard_meta(self, dashboard_id: str) -> DashboardRuntimeMetaRecord:
        return DashboardRuntimeMetaRecord(
            id=dashboard_id,
            title=f"Dashboard {dashboard_id}",
            status=DashboardStatus.DRAFT,
            has_published_revision=False,
            published_revision_id=None,
            updated_at=datetime.now(UTC),
        )

    @staticmethod
    def _optional_str(value: Any) -> str | None:
        if value is None:
            return None
        return str(value)

    @staticmethod
    def _coerce_datetime(value: Any) -> datetime:
        if isinstance(value, datetime):
            return value
        return datetime.now(UTC)
