from typing import Any

from app.core.auth_context import ActorContext
from app.core.config import Settings


def build_semantic_rag_context(
    *,
    db: Any,
    settings: Settings,
    actor: ActorContext,
    query: str,
    dataset_ids: list[str],
    semantic_model_id: str | None = None,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Keep the AI response shape while RAG retrieval is removed."""
    resolved_dataset_ids = list(dict.fromkeys(
        str(item).strip() for item in dataset_ids if str(item).strip()
    ))
    return {
        "sources": [],
        "retrieval": {
            "mode": "disabled",
            "status": "disabled",
            "provenance": "rag_removed",
            "datasetIds": resolved_dataset_ids,
            "resultCount": 0,
        },
    }
