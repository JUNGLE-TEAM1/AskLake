from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os
from typing import Any, Callable
from urllib.parse import urlparse


SOURCE_WINDOW_IDENTITY_CONTRACT_VERSION = 2
DEFAULT_IDENTITY_WORKERS = 16
MAX_IDENTITY_WORKERS = 64


def source_change_detection_mode(source_collection: dict[str, Any] | None) -> str:
    collection = source_collection if isinstance(source_collection, dict) else {}
    try:
        contract_version = int(collection.get("windowContractVersion"))
    except (TypeError, ValueError):
        contract_version = 0
    inventory = collection.get("objectInventory")
    if contract_version != SOURCE_WINDOW_IDENTITY_CONTRACT_VERSION or not isinstance(inventory, list) or not inventory:
        return "etag"
    version_ids = [
        normalize_version_id(item.get("versionId") or item.get("VersionId"))
        for item in inventory
        if isinstance(item, dict)
    ]
    return "versionid" if len(version_ids) == len(inventory) and all(version_ids) else "etag"


def verify_incremental_source_inventory(
    source_path: str,
    source_collection: dict[str, Any] | None,
    status_loader: Callable[[str], dict[str, Any]],
) -> list[str]:
    collection = source_collection if isinstance(source_collection, dict) else {}
    if not is_incremental_folder_collection(collection):
        return []
    try:
        contract_version = int(collection.get("windowContractVersion"))
    except (TypeError, ValueError):
        contract_version = 0
    if contract_version == 1:
        return []
    if contract_version != SOURCE_WINDOW_IDENTITY_CONTRACT_VERSION:
        raise ValueError(f"SOURCE_OBJECT_INVENTORY_INVALID unsupported contract version={contract_version}")

    raw_keys = collection.get("objectKeys")
    raw_inventory = collection.get("objectInventory")
    if not isinstance(raw_keys, list) or not isinstance(raw_inventory, list):
        raise ValueError(
            "SOURCE_OBJECT_INVENTORY_REQUIRED v2 incremental source manifests require objectKeys and objectInventory"
        )

    object_keys = [str(key).strip() for key in raw_keys if str(key).strip()]
    if len(object_keys) != len(set(object_keys)):
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID objectKeys contains duplicates")

    inventory_by_key: dict[str, dict[str, Any]] = {}
    for item in raw_inventory:
        expected = normalize_object_identity(item)
        key = expected["key"]
        if key in inventory_by_key:
            raise ValueError(f"SOURCE_OBJECT_INVENTORY_INVALID duplicate identity for key={key}")
        inventory_by_key[key] = expected

    if sorted(object_keys) != sorted(inventory_by_key):
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID objectKeys and objectInventory do not match")

    paths_by_key = incremental_source_paths_by_key(source_path, object_keys)

    def verify_one(key: str) -> str:
        expected = inventory_by_key[key]
        path = paths_by_key[key]
        try:
            actual = normalize_object_identity(status_loader(path), expected_key=key)
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(
                f"SOURCE_OBJECT_IDENTITY_UNAVAILABLE key={key} reason={compact_error(exc)}"
            ) from exc
        mismatches = [
            field
            for field in ("eTag", "versionId", "lastModified", "size")
            if expected[field] != actual[field]
        ]
        if mismatches:
            raise ValueError(
                f"SOURCE_OBJECT_IDENTITY_MISMATCH key={key} fields={','.join(mismatches)}"
            )
        return path

    keys = sorted(inventory_by_key)
    if not keys:
        return []
    with ThreadPoolExecutor(
        max_workers=identity_worker_count(len(keys)),
        thread_name_prefix="asklake-spark-identity",
    ) as executor:
        return list(executor.map(verify_one, keys))


def normalize_object_identity(value: Any, *, expected_key: str | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID object identity must be an object")
    key = str(value.get("key") or value.get("Key") or expected_key or "").strip()
    e_tag = normalize_etag(value.get("eTag") or value.get("ETag") or value.get("etag"))
    last_modified = normalize_last_modified(value.get("lastModified") or value.get("LastModified"))
    raw_size = value.get("size") if "size" in value else value.get("Size")
    if isinstance(raw_size, bool):
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID object size is missing or invalid")
    try:
        size = int(raw_size)
    except (TypeError, ValueError) as exc:
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID object size is missing or invalid") from exc
    if isinstance(raw_size, float) and not raw_size.is_integer():
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID object size is missing or invalid")
    if not key or not e_tag or last_modified is None or size < 0:
        raise ValueError("SOURCE_OBJECT_INVENTORY_INVALID object identity is incomplete")
    return {
        "key": key,
        "eTag": e_tag,
        "versionId": normalize_version_id(value.get("versionId") or value.get("VersionId")),
        "lastModified": last_modified,
        "size": size,
    }


def incremental_source_paths_by_key(source_path: str, object_keys: list[str]) -> dict[str, str]:
    parsed = urlparse(str(source_path or ""))
    scheme = parsed.scheme.casefold()
    bucket = parsed.netloc.strip()
    if scheme not in {"s3", "s3a"} or not bucket:
        raise ValueError(
            "SOURCE_OBJECT_INVENTORY_INVALID incremental object identity requires an s3:// or s3a:// source path"
        )
    return {
        key: f"{scheme}://{bucket}/{key.lstrip('/')}"
        for key in object_keys
    }


def is_incremental_folder_collection(source_collection: dict[str, Any]) -> bool:
    return (
        str(source_collection.get("scope") or "file").casefold() == "folder"
        and str(source_collection.get("mode") or "full").casefold() == "incremental"
    )


def normalize_etag(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    if len(normalized) >= 2 and normalized[0] == normalized[-1] == '"':
        normalized = normalized[1:-1]
    return normalized


def normalize_version_id(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return None if not normalized or normalized.casefold() == "null" else normalized


def normalize_last_modified(value: Any) -> int | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        normalized = str(value or "").strip()
        if not normalized:
            return None
        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return round(parsed.astimezone(timezone.utc).timestamp() * 1000)


def compact_error(error: Exception, *, limit: int = 300) -> str:
    text = " ".join(str(error).split()) or error.__class__.__name__
    return text[:limit]


def identity_worker_count(item_count: int) -> int:
    try:
        configured = int(os.environ.get("ASKLAKE_SOURCE_IDENTITY_WORKERS") or DEFAULT_IDENTITY_WORKERS)
    except ValueError:
        configured = DEFAULT_IDENTITY_WORKERS
    return max(1, min(item_count, configured, MAX_IDENTITY_WORKERS))
