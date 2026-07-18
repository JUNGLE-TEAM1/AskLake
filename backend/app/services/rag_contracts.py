from dataclasses import dataclass

from app.schemas.semantic import RagJobStage


RAG_PARENT_SCHEMA_VERSION = "rag-parent-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
CHUNKING_VERSION = "rag-chunk-v3"
FIELD_RENDERING_VERSION = "field_blocks_v1"
FILTER_CONTRACT_VERSION = "typed-filter-v1"
RAG_JOB_LIST_DEFAULT_LIMIT = 20
RAG_JOB_LIST_MAX_LIMIT = 100
RAG_JOB_STAGES: tuple[RagJobStage, ...] = (
    "queued",
    "staging",
    "chunking",
    "embedding",
    "indexing",
    "validating",
    "ready",
)
RAG_JOB_STAGE_ORDER = {
    stage: index
    for index, stage in enumerate(RAG_JOB_STAGES)
}


@dataclass(frozen=True)
class RagJobCompletionState:
    stage: RagJobStage
    is_complete: bool
    progress_percent: int | None
    progress_determinate: bool
