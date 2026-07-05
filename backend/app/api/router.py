from fastapi import APIRouter

from app.api.catalog import router as catalog_router
from app.api.health import router as health_router
from app.api.sql import router as sql_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(catalog_router)
api_router.include_router(sql_router)
