from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

engine_options: dict[str, object] = {"pool_pre_ping": True}
if settings.database_url.startswith(("postgresql://", "postgresql+")):
    engine_options["connect_args"] = {
        "connect_timeout": settings.database_connect_timeout_seconds,
        "options": (
            "-c idle_in_transaction_session_timeout="
            f"{settings.database_idle_in_transaction_timeout_seconds * 1000}"
        ),
    }

engine = create_engine(settings.database_url, **engine_options)

SessionLocal = sessionmaker(
    autoflush=False,
    autocommit=False,
    bind=engine,
    class_=Session,
)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        try:
            if db.in_transaction():
                try:
                    db.rollback()
                except SQLAlchemyError:
                    # Closing still invalidates/releases a broken connection.
                    pass
        finally:
            db.close()
