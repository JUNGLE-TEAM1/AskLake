from fastapi import APIRouter

from app.api.catalog import router as catalog_router
from app.api.etl import router as etl_router
from app.api.health import router as health_router
from app.api.query import router as query_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(etl_router)
api_router.include_router(catalog_router)
api_router.include_router(query_router)
