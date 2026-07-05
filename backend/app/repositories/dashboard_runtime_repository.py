from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, inspect, select, text
from sqlalchemy.orm import Session

from app.models.dashboard_runtime import DashboardPage, DashboardRevision, DashboardWidget
from app.repositories.dashboard_card_repository import ensure_dashboard_card_schema
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
        self._ensure_dashboard_meta_table()
        if self._dashboards_table_exists():
            return self._get_dashboard_meta_from_card_list_table(dashboard_id)
        return None

    def get_published_revision(self, dashboard_id: str) -> DashboardRevision | None:
        return self._get_revision_by_kind(dashboard_id, DashboardRuntimeMode.PUBLISHED)

    def get_draft_revision(self, dashboard_id: str) -> DashboardRevision | None:
        return self._get_revision_by_kind(dashboard_id, DashboardRuntimeMode.DRAFT)

    def get_next_revision_version(self, dashboard_id: str) -> int:
        statement = (
            select(DashboardRevision.version)
            .where(DashboardRevision.dashboard_id == dashboard_id)
            .order_by(DashboardRevision.version.desc())
            .limit(1)
        )
        current_version = self.db.scalars(statement).first()
        return (current_version or 0) + 1

    def create_revision(
        self,
        dashboard_id: str,
        kind: DashboardRuntimeMode,
        *,
        published_at: datetime | None = None,
    ) -> DashboardRevision:
        revision = DashboardRevision(
            id=self._new_id("dashrev"),
            dashboard_id=dashboard_id,
            kind=kind.value,
            version=self.get_next_revision_version(dashboard_id),
            published_at=published_at,
        )
        self.db.add(revision)
        self.db.flush()
        return revision

    def create_page(self, revision_id: str, title: str, order_index: int) -> DashboardPage:
        page = DashboardPage(
            id=self._new_id("dashpage"),
            revision_id=revision_id,
            title=title,
            order_index=order_index,
        )
        self.db.add(page)
        self.db.flush()
        return page

    def get_page(self, page_id: str) -> DashboardPage | None:
        return self.db.get(DashboardPage, page_id)

    def get_next_page_order(self, revision_id: str) -> int:
        statement = (
            select(DashboardPage.order_index)
            .where(DashboardPage.revision_id == revision_id)
            .order_by(DashboardPage.order_index.desc())
            .limit(1)
        )
        current_order = self.db.scalars(statement).first()
        return (current_order if current_order is not None else -1) + 1

    def update_page_title(self, page: DashboardPage, title: str) -> DashboardPage:
        page.title = title
        self.db.flush()
        return page

    def delete_page(self, page: DashboardPage) -> None:
        self.db.execute(delete(DashboardWidget).where(DashboardWidget.page_id == page.id))
        self.db.delete(page)
        self.db.flush()

    def create_widget(
        self,
        page_id: str,
        *,
        widget_type: str,
        title: str | None,
        layout: dict[str, Any],
        config: dict[str, Any],
        data: list[dict[str, Any]],
        dataset_id: str | None = None,
        query_id: str | None = None,
    ) -> DashboardWidget:
        widget = DashboardWidget(
            id=self._new_id("dashwidget"),
            page_id=page_id,
            type=widget_type,
            title=title,
            dataset_id=dataset_id,
            query_id=query_id,
            layout=layout,
            config=config,
            data=data,
        )
        self.db.add(widget)
        self.db.flush()
        return widget

    def get_widget(self, widget_id: str) -> DashboardWidget | None:
        return self.db.get(DashboardWidget, widget_id)

    def update_widget(
        self,
        widget: DashboardWidget,
        *,
        widget_type: str | None = None,
        title: str | None = None,
        update_title: bool = False,
        dataset_id: str | None = None,
        update_dataset_id: bool = False,
        config: dict[str, Any] | None = None,
    ) -> DashboardWidget:
        if widget_type is not None:
            widget.type = widget_type
        if update_title:
            widget.title = title
        if update_dataset_id:
            widget.dataset_id = dataset_id
        if config is not None:
            widget.config = config
        self.db.flush()
        return widget

    def delete_widget(self, widget: DashboardWidget) -> None:
        self.db.delete(widget)
        self.db.flush()

    def update_widget_layout(self, widget: DashboardWidget, layout: dict[str, Any]) -> DashboardWidget:
        widget.layout = layout
        self.db.flush()
        return widget

    def copy_revision(self, source_revision: DashboardRevision, target_kind: DashboardRuntimeMode) -> DashboardRevision:
        target_revision = self.create_revision(
            source_revision.dashboard_id,
            target_kind,
            published_at=datetime.now(UTC) if target_kind == DashboardRuntimeMode.PUBLISHED else None,
        )
        for source_page in self.list_pages(source_revision.id):
            target_page = self.create_page(target_revision.id, source_page.title, source_page.order_index)
            for source_widget in self.list_widgets_by_page_ids([source_page.id]).get(source_page.id, []):
                self.create_widget(
                    target_page.id,
                    widget_type=source_widget.type,
                    title=source_widget.title,
                    dataset_id=source_widget.dataset_id,
                    query_id=source_widget.query_id,
                    layout=dict(source_widget.layout),
                    config=dict(source_widget.config),
                    data=list(source_widget.data),
                )
        return target_revision

    def update_dashboard_published_metadata(self, dashboard_id: str, published_revision_id: str, published_at: datetime) -> None:
        if not self._dashboards_table_exists():
            return

        columns = {column["name"] for column in inspect(self.db.connection()).get_columns("dashboards")}
        updates: list[str] = []
        values: dict[str, Any] = {
            "dashboard_id": dashboard_id,
            "published_revision_id": published_revision_id,
            "published_at": published_at,
        }
        if "published_revision_id" in columns:
            updates.append("published_revision_id = :published_revision_id")
        if "has_published_revision" in columns:
            updates.append("has_published_revision = true")
        if "status" in columns:
            updates.append("status = 'published'")
        if "updated_at" in columns:
            updates.append("updated_at = :published_at")
        if not updates:
            return

        self.db.execute(
            text(f"UPDATE dashboards SET {', '.join(updates)} WHERE id = :dashboard_id"),
            values,
        )
        self.db.flush()

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
        return inspect(self.db.connection()).has_table("dashboards")

    def _ensure_dashboard_meta_table(self) -> None:
        if self._dashboards_table_exists():
            return

        bind = self.db.get_bind()
        if bind.dialect.name == "sqlite":
            return

        ensure_dashboard_card_schema(self.db)

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

    @staticmethod
    def _new_id(prefix: str) -> str:
        return f"{prefix}_{uuid4().hex[:12]}"
