from dataclasses import dataclass
import hashlib
import json
from typing import Any

from app.core.auth_context import ActorContext
from app.schemas.dashboard import DashboardRuntimeWidgetType
from app.services.dashboard_physical_data import dashboard_source_config


BATCH_CACHE_CONTRACT_VERSION = 1


@dataclass(frozen=True)
class DashboardBatchCacheIdentity:
    actor_scope_hash: str
    cache_key: str
    config_hash: str
    dataset_version: str


def _sha256_json(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def dashboard_batch_dataset_version(payload: dict[str, Any]) -> str:
    return _sha256_json({
        "icebergSnapshotId": payload.get("icebergSnapshotId"),
        "icebergTable": payload.get("icebergTable"),
        "lastUpdated": payload.get("lastUpdated"),
        "materializationRuns": payload.get("materializationRuns") or [],
        "queryEngineTable": payload.get("queryEngineTable"),
        "schemaFingerprint": payload.get("schemaFingerprint"),
        "sourceRunId": payload.get("sourceRunId"),
        "storageFormat": payload.get("storageFormat"),
        "storageLocation": payload.get("storageLocation"),
    })


def dashboard_actor_scope_hash(actor: ActorContext) -> str:
    return _sha256_json({
        "email": actor.email,
        "groups": sorted(actor.groups),
        "id": actor.id,
        "name": actor.name,
        "role": actor.role,
    })


def dashboard_batch_cache_identity(
    payload: dict[str, Any],
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any],
    actor: ActorContext,
) -> DashboardBatchCacheIdentity:
    dataset_version = dashboard_batch_dataset_version(payload)
    config_hash = _sha256_json(dashboard_source_config(config))
    actor_scope_hash = dashboard_actor_scope_hash(actor)
    cache_key = _sha256_json({
        "actorScope": actor_scope_hash,
        "config": config_hash,
        "contractVersion": BATCH_CACHE_CONTRACT_VERSION,
        "datasetId": payload.get("id"),
        "datasetVersion": dataset_version,
        "widgetType": widget_type.value,
    })
    return DashboardBatchCacheIdentity(
        actor_scope_hash=actor_scope_hash,
        cache_key=cache_key,
        config_hash=config_hash,
        dataset_version=dataset_version,
    )
