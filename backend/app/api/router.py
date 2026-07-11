from fastapi import APIRouter

from app.api.admin import router as admin_router
from app.api.airflow_execution import router as airflow_execution_router
from app.api.auth import router as auth_router
from app.api.catalog import router as catalog_router
from app.api.dashboard_assistant import router as dashboard_assistant_router
from app.api.dashboard_card import router as dashboard_card_router
from app.api.dashboard_runtime import router as dashboard_runtime_router
from app.api.demo_hydration import router as demo_hydration_router
from app.api.etl import router as etl_router
from app.api.harness import router as harness_router
from app.api.health import router as health_router
from app.api.sql import router as sql_router
from app.api.sql_test import router as sql_test_router
from app.api.users import router as users_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(harness_router)
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(admin_router)
api_router.include_router(airflow_execution_router)
api_router.include_router(etl_router)
api_router.include_router(catalog_router)
api_router.include_router(sql_router)
api_router.include_router(sql_test_router)
api_router.include_router(dashboard_card_router)
api_router.include_router(dashboard_runtime_router)
api_router.include_router(dashboard_assistant_router)
api_router.include_router(demo_hydration_router, prefix="/demo")
