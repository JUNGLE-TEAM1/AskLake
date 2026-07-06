from fastapi import APIRouter

from app.api.dashboard_card import router as dashboard_card_router
from app.api.dashboard_runtime import router as dashboard_runtime_router
from app.api.demo_hydration import router as demo_hydration_router
from app.api.health import router as health_router

api_router = APIRouter()
api_router.include_router(dashboard_card_router)
api_router.include_router(dashboard_runtime_router)
api_router.include_router(demo_hydration_router)
api_router.include_router(health_router, tags=["health"])
