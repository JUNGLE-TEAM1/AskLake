from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy.orm import Session

from app.core.config import settings


_metadata_schema_bootstrap_active: ContextVar[bool] = ContextVar(
    "metadata_schema_bootstrap_active",
    default=False,
)


@contextmanager
def metadata_schema_bootstrap() -> Iterator[None]:
    """Authorize metadata DDL only for the explicit migration runner."""
    token = _metadata_schema_bootstrap_active.set(True)
    try:
        yield
    finally:
        _metadata_schema_bootstrap_active.reset(token)


def metadata_schema_mutation_allowed(db: Session, component: str) -> bool:
    """Return whether a compatibility schema helper may execute metadata DDL."""
    if _metadata_schema_bootstrap_active.get():
        return True
    if not settings.startup_schema_management_enabled:
        return False
    dialect_name = str(getattr(getattr(db.get_bind(), "dialect", None), "name", "") or "")
    if dialect_name == "postgresql":
        raise RuntimeError(
            f"{component} metadata schema was not bootstrapped by the explicit migration runner"
        )
    # SQLite/local fixtures keep their existing self-contained bootstrap.
    return True
