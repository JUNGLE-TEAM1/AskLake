"""Atomic durable lease for the Continuous control-plane worker."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import case, or_
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models import ContinuousControlLeaseModel


def acquire_or_renew(
    db: Session,
    *,
    control_plane: str,
    owner_id: str,
    lease_seconds: int,
) -> int | None:
    """Atomically acquire an expired lease or renew the current owner's lease.

    Schema preparation intentionally lives in the deployment migration command,
    never in this worker hot path. PostgreSQL uses one conditional upsert so two
    workers cannot both claim the same expired control plane.
    """
    if lease_seconds < 1:
        raise ValueError("lease_seconds must be positive")
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=lease_seconds)
    table = ContinuousControlLeaseModel.__table__
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else postgresql_insert
    statement = insert(table).values(
        control_plane=control_plane,
        owner_id=owner_id,
        generation=1,
        expires_at=expires_at,
    )
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.control_plane],
        set_={
            "owner_id": owner_id,
            "generation": case(
                (table.c.owner_id == owner_id, table.c.generation),
                else_=table.c.generation + 1,
            ),
            "expires_at": expires_at,
        },
        where=or_(
            table.c.owner_id == owner_id,
            table.c.expires_at.is_(None),
            table.c.expires_at <= now,
        ),
    ).returning(table.c.generation)
    generation = db.execute(statement).scalar_one_or_none()
    db.commit()
    return int(generation) if generation is not None else None
