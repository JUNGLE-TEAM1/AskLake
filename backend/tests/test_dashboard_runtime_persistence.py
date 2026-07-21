from datetime import UTC, datetime
import unittest

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.models.realtime import RealtimeEventModel
from app.repositories.dashboard_runtime_repository import (
    DashboardRuntimeMetaRecord,
    DashboardRuntimeRepository,
)
from app.schemas.dashboard import (
    CreateDraftWidgetRequest,
    CreateDraftPageRequest,
    DashboardCard,
    DashboardMeta,
    DashboardRuntimeMode,
    DashboardRuntimeWidgetType,
    DashboardStatus,
    DashboardWidgetAggregation,
    DashboardWidgetFormat,
    DashboardWidgetFilter,
    DashboardWidgetLayout,
    DraftLayoutItem,
    MetricWidgetConfig,
    SaveDraftLayoutsRequest,
    UpdateDraftWidgetRequest,
)
from app.schemas.permissions import ResourcePermissions
from app.services.dashboard_runtime_service import DashboardRuntimeService


class EmptyCatalogRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    @staticmethod
    def get_dataset_payload(_dataset_id: str):
        return None


class PersistenceDashboardRuntimeService(DashboardRuntimeService):
    def _require_dashboard_permission(
        self,
        dashboard_id: str,
        actor: ActorContext,
        action: str,
    ) -> DashboardCard:
        del actor, action
        return DashboardCard(
            id=dashboard_id,
            name="Persistence dashboard",
            owner="Admin User",
            meta="1 widget",
            status=DashboardStatus.DRAFT,
            tags="test",
            updated="now",
        )

    def _dashboard_meta_to_schema(
        self,
        record: DashboardRuntimeMetaRecord,
        has_published_revision: bool,
        actor: ActorContext,
        dashboard_card: DashboardCard,
    ) -> DashboardMeta:
        del dashboard_card
        return DashboardMeta(
            id=record.id,
            title=record.title,
            status=(
                DashboardStatus.PUBLISHED
                if has_published_revision
                else record.status
            ),
            permissions=ResourcePermissions(
                can_view=True,
                can_manage=True,
                computed_for=actor.name,
                enforced=True,
            ),
            has_published_revision=has_published_revision,
            updated_at=record.updated_at.astimezone(UTC).isoformat(),
        )


class DashboardRuntimePersistenceTests(unittest.TestCase):
    dashboard_id = "dashboard-persistence"

    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(self.engine) as db:
            migrate_dashboard_schema(db)
        RealtimeEventModel.metadata.create_all(
            self.engine,
            tables=[
                RealtimeEventModel.__table__,
            ],
        )
        with self.engine.begin() as connection:
            connection.execute(
                text("""
                    INSERT INTO dashboards (
                        id,
                        name,
                        owner,
                        status,
                        has_published_revision,
                        created_at,
                        updated_at
                    ) VALUES (
                        :id,
                        :name,
                        :owner,
                        :status,
                        0,
                        :created_at,
                        :updated_at
                    )
                """),
                {
                    "id": self.dashboard_id,
                    "name": "Persistence dashboard",
                    "owner": "Admin User",
                    "status": DashboardStatus.DRAFT.value,
                    "created_at": datetime(2026, 7, 16, tzinfo=UTC),
                    "updated_at": datetime(2026, 7, 16, tzinfo=UTC),
                },
            )

    def tearDown(self) -> None:
        self.engine.dispose()

    def service(self, db: Session) -> PersistenceDashboardRuntimeService:
        return PersistenceDashboardRuntimeService(
            DashboardRuntimeRepository(db),
            EmptyCatalogRepository(db),  # type: ignore[arg-type]
        )

    @staticmethod
    def widget_by_id(runtime, widget_id: str):
        return next(
            widget
            for widgets in runtime.widgets_by_page_id.values()
            for widget in widgets
            if widget.id == widget_id
        )

    def create_metric_widget(
        self,
        service: PersistenceDashboardRuntimeService,
        page_id: str,
        *,
        title: str = "Orders",
    ) -> str:
        response = service.create_draft_widget(
            self.dashboard_id,
            page_id,
            CreateDraftWidgetRequest(
                type=DashboardRuntimeWidgetType.METRIC,
                title=title,
                layout=DashboardWidgetLayout(x=0, y=0, w=4, h=3),
                config=MetricWidgetConfig(
                    aggregation=DashboardWidgetAggregation.COUNT,
                    value_key="value",
                    format=DashboardWidgetFormat.NUMBER,
                ),
                data=[{"value": 7}],
            ),
            ActorContext(name="Admin User", role="admin"),
        )
        return response.id

    def test_draft_layout_widget_update_and_publish_survive_new_sessions(self) -> None:
        actor = ActorContext(name="Admin User", role="admin")
        with Session(self.engine) as db:
            service = self.service(db)
            draft = service.ensure_draft_runtime(self.dashboard_id, actor)
            page_id = draft.pages[0].id
            widget_id = self.create_metric_widget(service, page_id)

            service.save_draft_layouts(
                self.dashboard_id,
                SaveDraftLayoutsRequest(
                    page_id=page_id,
                    layouts=[DraftLayoutItem(
                        widget_id=widget_id,
                        x=2,
                        y=3,
                        w=6,
                        h=4,
                    )],
                ),
                actor,
            )
            service.update_draft_widget(
                self.dashboard_id,
                widget_id,
                UpdateDraftWidgetRequest(
                    title="Revenue",
                    config=MetricWidgetConfig(
                        aggregation=DashboardWidgetAggregation.SUM,
                        filters=[DashboardWidgetFilter(
                            id="membership-filter",
                            column="membership",
                            operator="eq",
                            value="vip",
                        )],
                        value_key="value",
                        format=DashboardWidgetFormat.CURRENCY,
                    ),
                ),
                actor,
            )

        with Session(self.engine) as db:
            service = self.service(db)
            reloaded_draft = service.ensure_draft_runtime(self.dashboard_id, actor)
            widget = self.widget_by_id(reloaded_draft, widget_id)
            self.assertEqual(widget.title, "Revenue")
            self.assertEqual(
                widget.layout.model_dump(by_alias=True, exclude_none=True),
                {"x": 2, "y": 3, "w": 6, "h": 4},
            )
            self.assertEqual(widget.config.aggregation, DashboardWidgetAggregation.SUM)
            self.assertEqual(widget.config.format, DashboardWidgetFormat.CURRENCY)
            self.assertEqual(widget.config.filters[0].column, "membership")
            self.assertEqual(widget.config.filters[0].value, "vip")
            self.assertEqual(widget.data, [{"value": 7}])

            published = service.publish_dashboard(self.dashboard_id, actor)
            self.assertEqual(published.dashboard_id, self.dashboard_id)

            service.save_draft_layouts(
                self.dashboard_id,
                SaveDraftLayoutsRequest(
                    page_id=page_id,
                    layouts=[DraftLayoutItem(
                        widget_id=widget_id,
                        x=8,
                        y=1,
                        w=4,
                        h=3,
                    )],
                ),
                actor,
            )

        with Session(self.engine) as db:
            service = self.service(db)
            published_runtime = service.get_published_runtime(self.dashboard_id, actor)
            published_page_id = published_runtime.pages[0].id
            published_widgets = published_runtime.widgets_by_page_id[published_page_id]
            self.assertEqual(len(published_widgets), 1)
            published_widget = published_widgets[0]
            self.assertEqual(published_runtime.mode, DashboardRuntimeMode.PUBLISHED)
            self.assertTrue(published_runtime.dashboard.has_published_revision)
            self.assertEqual(published_widget.config.filters[0].column, "membership")
            self.assertEqual(published_widget.config.filters[0].value, "vip")
            self.assertEqual(
                published_widget.layout.model_dump(by_alias=True, exclude_none=True),
                {"x": 2, "y": 3, "w": 6, "h": 4},
            )

            draft_runtime = service.ensure_draft_runtime(self.dashboard_id, actor)
            draft_widget = self.widget_by_id(draft_runtime, widget_id)
            self.assertEqual(
                draft_widget.layout.model_dump(by_alias=True, exclude_none=True),
                {"x": 8, "y": 1, "w": 4, "h": 3},
            )

    def test_widget_mutations_return_only_the_saved_runtime_widget(self) -> None:
        actor = ActorContext(name="Admin User", role="admin")
        with Session(self.engine) as db:
            service = self.service(db)
            draft = service.ensure_draft_runtime(self.dashboard_id, actor)
            page_id = draft.pages[0].id

            created = service.create_draft_widget(
                self.dashboard_id,
                page_id,
                CreateDraftWidgetRequest(
                    type=DashboardRuntimeWidgetType.METRIC,
                    title="Orders",
                    layout=DashboardWidgetLayout(x=0, y=0, w=4, h=3),
                    config=MetricWidgetConfig(
                        aggregation=DashboardWidgetAggregation.COUNT,
                        value_key="value",
                        format=DashboardWidgetFormat.NUMBER,
                    ),
                    data=[{"value": 7}],
                ),
                actor,
            )

            self.assertEqual(created.id, created.widget.id)
            self.assertEqual(created.widget.page_id, page_id)
            self.assertEqual(created.widget.title, "Orders")
            self.assertEqual(created.widget.data, [{"value": 7}])

            updated = service.update_draft_widget(
                self.dashboard_id,
                created.id,
                UpdateDraftWidgetRequest(title="Revenue"),
                actor,
            )

            self.assertEqual(updated.id, created.id)
            self.assertEqual(updated.widget.title, "Revenue")
            self.assertEqual(updated.widget.data, [{"value": 7}])

    def test_deleting_the_last_page_returns_a_replacement_page(self) -> None:
        actor = ActorContext(name="Admin User", role="admin")
        with Session(self.engine) as db:
            service = self.service(db)
            draft = service.ensure_draft_runtime(self.dashboard_id, actor)

            response = service.delete_draft_page(self.dashboard_id, draft.pages[0].id, actor)

            self.assertTrue(response.ok)
            self.assertIsNotNone(response.replacement_page)
            replacement_page = response.replacement_page
            assert replacement_page is not None
            self.assertEqual(replacement_page.title, "Untitled page")
            self.assertEqual(replacement_page.order_index, 0)

    def test_cross_page_layout_failure_rolls_back_partial_updates_on_session_close(self) -> None:
        actor = ActorContext(name="Admin User", role="admin")
        with Session(self.engine) as db:
            service = self.service(db)
            draft = service.ensure_draft_runtime(self.dashboard_id, actor)
            first_page_id = draft.pages[0].id
            first_widget_id = self.create_metric_widget(service, first_page_id, title="First")
            second_page = service.create_draft_page(
                self.dashboard_id,
                CreateDraftPageRequest(title="Second page"),
                actor,
            )
            second_widget_id = self.create_metric_widget(service, second_page.id, title="Second")

            with self.assertRaises(ApiError):
                service.save_draft_layouts(
                    self.dashboard_id,
                    SaveDraftLayoutsRequest(
                        page_id=first_page_id,
                        layouts=[
                            DraftLayoutItem(
                                widget_id=first_widget_id,
                                x=5,
                                y=5,
                                w=4,
                                h=3,
                            ),
                            DraftLayoutItem(
                                widget_id=second_widget_id,
                                x=1,
                                y=1,
                                w=4,
                                h=3,
                            ),
                        ],
                    ),
                    actor,
                )

        with Session(self.engine) as db:
            repository = DashboardRuntimeRepository(db)
            first_widget = repository.get_widget(first_widget_id)
            self.assertIsNotNone(first_widget)
            self.assertEqual(first_widget.layout, {"x": 0, "y": 0, "w": 4, "h": 3})


if __name__ == "__main__":
    unittest.main()
