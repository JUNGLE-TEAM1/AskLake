from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.services import etl_service

router = APIRouter(prefix="/text-structuring", tags=["text-structuring"])


@router.get("/models")
def list_text_structuring_models() -> dict[str, list[dict[str, Any]]]:
    return {"models": etl_service.list_text_structuring_models()}


@router.post("/training-runs")
def create_text_structuring_training_run(request: dict[str, Any]) -> dict[str, Any]:
    return etl_service.create_text_structuring_training_run(request)
