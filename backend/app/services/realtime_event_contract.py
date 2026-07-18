import json
from collections.abc import Mapping, Sequence
from typing import Any

from app.core.config import settings


REALTIME_EVENT_SCHEMA_VERSION = 1
REALTIME_EVENT_SCHEMA_VERSION_V2 = 2
REALTIME_SCOPE_ID = "deployment"
EVENT_TYPE_REGISTRY: dict[str, tuple[str, frozenset[str]]] = {
    "dataset.revision.committed": (
        "dataset",
        frozenset({"runId", "commitKind"}),
    ),
    "dashboard.published": (
        "dashboard",
        frozenset({"publishedRevisionId"}),
    ),
}
SECRET_KEY_FRAGMENTS = (
    "authorization",
    "cookie",
    "credential",
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
)


def validate_realtime_event(
    *,
    event_type: str,
    resource_type: str,
    resource_id: str,
    aggregate_revision: int,
    correlation_id: str,
    invalidations: list[str],
    payload: dict[str, Any],
    schema_version: int = REALTIME_EVENT_SCHEMA_VERSION,
) -> None:
    registry_entry = EVENT_TYPE_REGISTRY.get(event_type)
    if registry_entry is None:
        raise ValueError(f"Unsupported realtime event type: {event_type}")
    expected_resource_type, allowed_payload_keys = registry_entry
    if resource_type != expected_resource_type:
        raise ValueError(f"Realtime event {event_type} requires resource type {expected_resource_type}")
    if not resource_id or len(resource_id) > 160:
        raise ValueError("Realtime event requires a bounded resource id")
    if aggregate_revision < 0:
        raise ValueError("Realtime event aggregate revision must be non-negative")
    if not correlation_id or len(correlation_id) > 160:
        raise ValueError("Realtime event requires a bounded correlation id")
    if len(invalidations) > 20 or any(not item or len(item) > 256 for item in invalidations):
        raise ValueError("Realtime event invalidation list is invalid")
    effective_allowed_keys = set(allowed_payload_keys)
    required_v2_keys: set[str] = set()
    if schema_version == REALTIME_EVENT_SCHEMA_VERSION_V2:
        if event_type != "dataset.revision.committed":
            raise ValueError("Realtime event schema v2 currently supports Dataset revisions only")
        required_v2_keys = {
            "bindingEpoch", "materializationId", "mutationType", "sourceBoundary",
            "servingVersionId", "pipelineVersionId",
        }
        effective_allowed_keys = required_v2_keys
    elif schema_version != REALTIME_EVENT_SCHEMA_VERSION:
        raise ValueError("Unsupported realtime event schema version")
    unexpected_payload_keys = set(payload) - effective_allowed_keys
    if unexpected_payload_keys:
        raise ValueError(
            "Realtime event payload contains unsupported fields: "
            + ", ".join(sorted(unexpected_payload_keys))
        )
    missing_payload_keys = required_v2_keys - set(payload)
    if missing_payload_keys:
        raise ValueError(
            "Realtime event schema v2 payload is missing fields: "
            + ", ".join(sorted(missing_payload_keys))
        )
    _reject_secret_fields(payload)
    encoded = json.dumps(
        {"invalidate": invalidations, "payload": payload},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    if len(encoded) > settings.realtime_event_payload_max_bytes:
        raise ValueError("Realtime event payload exceeds the configured size limit")


def _reject_secret_fields(value: Any, *, path: tuple[str, ...] = ()) -> None:
    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key)
            normalized_key = key.casefold().replace("-", "_")
            if any(fragment in normalized_key for fragment in SECRET_KEY_FRAGMENTS):
                location = ".".join((*path, key))
                raise ValueError(f"Realtime event payload contains a secret-like field: {location}")
            _reject_secret_fields(child, path=(*path, key))
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _reject_secret_fields(child, path=(*path, str(index)))
