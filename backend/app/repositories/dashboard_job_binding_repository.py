from __future__ import annotations

from weakref import WeakSet

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.base import Base
from app.models.dashboard_job_binding import DashboardBindingDeliveryModel, DashboardJobBindingModel


DASHBOARD_JOB_BINDING_TABLES = [
    DashboardJobBindingModel.__table__,
    DashboardBindingDeliveryModel.__table__,
]
_schema_ready_binds: WeakSet = WeakSet()


def ensure_dashboard_job_binding_schema(db: Session) -> None:
    bind = db.get_bind()
    if bind in _schema_ready_binds:
        return
    Base.metadata.create_all(bind=bind, tables=DASHBOARD_JOB_BINDING_TABLES)
    _schema_ready_binds.add(bind)


class DashboardJobBindingRepository:
    def __init__(self, db: Session) -> None:
        self.db = db
        ensure_dashboard_job_binding_schema(db)

    def get(self, binding_id: str) -> DashboardJobBindingModel | None:
        return self.db.get(DashboardJobBindingModel, binding_id)

    def get_by_dashboard(self, dashboard_id: str) -> DashboardJobBindingModel | None:
        return self.db.scalars(select(DashboardJobBindingModel).where(DashboardJobBindingModel.dashboard_id == dashboard_id)).first()

    def list(self, *, job_id: str | None = None, job_kind: str | None = None, dashboard_id: str | None = None) -> list[DashboardJobBindingModel]:
        statement = select(DashboardJobBindingModel)
        if job_id is not None:
            statement = statement.where(DashboardJobBindingModel.job_id == job_id)
        if job_kind is not None:
            statement = statement.where(DashboardJobBindingModel.job_kind == job_kind)
        if dashboard_id is not None:
            statement = statement.where(DashboardJobBindingModel.dashboard_id == dashboard_id)
        return list(self.db.scalars(statement.order_by(DashboardJobBindingModel.updated_at.desc())).all())

    def save(self, binding: DashboardJobBindingModel) -> DashboardJobBindingModel:
        self.db.add(binding)
        self.db.commit()
        self.db.refresh(binding)
        return binding

    def get_delivery(self, binding_id: str, dataset_revision: int) -> DashboardBindingDeliveryModel | None:
        return self.db.scalars(select(DashboardBindingDeliveryModel).where(
            DashboardBindingDeliveryModel.binding_id == binding_id,
            DashboardBindingDeliveryModel.dataset_revision == dataset_revision,
        )).first()

    def list_active(self) -> list[DashboardJobBindingModel]:
        return list(self.db.scalars(
            select(DashboardJobBindingModel).where(
                DashboardJobBindingModel.mode == "managed",
                DashboardJobBindingModel.enabled.is_(True),
            ).order_by(DashboardJobBindingModel.updated_at.asc())
        ).all())

    def list_deliveries(self, *, statuses: tuple[str, ...] = ("pending", "calculating")) -> list[DashboardBindingDeliveryModel]:
        return list(self.db.scalars(
            select(DashboardBindingDeliveryModel)
            .where(DashboardBindingDeliveryModel.status.in_(statuses))
            .order_by(DashboardBindingDeliveryModel.updated_at.asc())
        ).all())
