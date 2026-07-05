from fastapi import APIRouter, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import SessionLocal
from app.schemas.common import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    database_ok = True
    database_message = "ok"

    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
    except SQLAlchemyError as error:
        database_ok = False
        database_message = error.__class__.__name__

    return HealthResponse(
        ok=database_ok,
        statusCode=status.HTTP_200_OK,
        database={"ok": database_ok, "message": database_message},
    )
