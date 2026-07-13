from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import EmrAdmissionReservationModel
from app.repositories.etl_repository import ensure_schema


NON_TERMINAL_STATUSES = frozenset({"admitted", "queued", "submitted", "running"})
ACTIVE_SLOT_STATUSES = frozenset({"admitted", "submitted", "running"})
TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled", "expired", "rejected"})


def lock_application_scope(db: Session, application_id: str, workload: str, job_id: str) -> None:
    """Serialize admission decisions across API processes before external submission."""
    ensure_schema(db)
    identity = f"emr-admission:{application_id}:{workload}"
    if db.get_bind().dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))"),
            {"identity": identity},
        )
        return
    # SQLite ignores row-level locks. This no-op write obtains its database writer
    # lock and is sufficient for the local/test single-database deployment.
    db.execute(text("UPDATE etl_jobs SET id = id WHERE id = :job_id"), {"job_id": job_id})


def get_reservation(db: Session, reservation_id: str) -> EmrAdmissionReservationModel | None:
    ensure_schema(db)
    return db.get(EmrAdmissionReservationModel, reservation_id)


def list_non_terminal(
    db: Session,
    *,
    application_id: str | None = None,
    workload: str | None = None,
) -> list[EmrAdmissionReservationModel]:
    ensure_schema(db)
    statement = select(EmrAdmissionReservationModel).where(
        EmrAdmissionReservationModel.status.in_(NON_TERMINAL_STATUSES)
    )
    if application_id is not None:
        statement = statement.where(EmrAdmissionReservationModel.application_id == application_id)
    if workload is not None:
        statement = statement.where(EmrAdmissionReservationModel.workload == workload)
    return list(db.scalars(statement.order_by(
        EmrAdmissionReservationModel.priority.desc(),
        EmrAdmissionReservationModel.created_at.asc(),
    )))


def list_reservations(db: Session, limit: int = 100) -> list[EmrAdmissionReservationModel]:
    ensure_schema(db)
    statement = (
        select(EmrAdmissionReservationModel)
        .order_by(EmrAdmissionReservationModel.created_at.desc())
        .limit(max(1, min(int(limit), 500)))
    )
    return list(db.scalars(statement))


def latest_for_job(
    db: Session,
    job_id: str,
    *,
    workload: str | None = None,
) -> EmrAdmissionReservationModel | None:
    ensure_schema(db)
    statement = select(EmrAdmissionReservationModel).where(
        EmrAdmissionReservationModel.job_id == job_id
    )
    if workload is not None:
        statement = statement.where(EmrAdmissionReservationModel.workload == workload)
    return db.scalar(statement.order_by(EmrAdmissionReservationModel.created_at.desc()).limit(1))


def add_reservation(db: Session, reservation: EmrAdmissionReservationModel) -> EmrAdmissionReservationModel:
    ensure_schema(db)
    db.add(reservation)
    return reservation
