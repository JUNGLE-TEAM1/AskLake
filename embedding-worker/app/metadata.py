from datetime import date, datetime
from typing import Any


def _is_iso_date(value: Any) -> bool:
    if isinstance(value, (date, datetime)):
        return True
    text = str(value or "").strip()
    if not text or len(text) < 10:
        return False
    try:
        date.fromisoformat(text[:10])
        return text[4] == "-" and text[7] == "-"
    except ValueError:
        return False


def typed_metadata_filter(metadata: dict[str, Any], expected_types: dict[str, str] | None = None) -> dict[str, dict[str, Any]]:
    """Encode exact and range-friendly metadata without losing display values."""
    result: dict[str, dict[str, Any]] = {}
    expected_types = expected_types or {}
    for key, value in metadata.items():
        expected = str(expected_types.get(str(key)) or "").casefold()
        if any(token in expected for token in ("boolean", "bool")):
            if isinstance(value, bool):
                normalized = value
            elif str(value).casefold() in {"true", "false"}:
                normalized = str(value).casefold() == "true"
            else:
                raise ValueError(f"Metadata field {key} is declared boolean but contains a non-boolean value")
            result[str(key)] = {"type": "boolean", "keyword": "true" if normalized else "false", "boolean": normalized}
        elif any(token in expected for token in ("int", "long", "float", "double", "decimal", "numeric", "number")):
            result[str(key)] = {"type": "number", "keyword": str(value), "number": float(value)}
        elif any(token in expected for token in ("date", "datetime", "timestamp", "time")):
            serialized = value.isoformat() if hasattr(value, "isoformat") else str(value)
            result[str(key)] = {"type": "date", "keyword": serialized, "date": serialized}
        elif isinstance(value, bool):
            result[str(key)] = {"type": "boolean", "keyword": "true" if value else "false", "boolean": value}
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            result[str(key)] = {"type": "number", "keyword": str(value), "number": float(value)}
        elif _is_iso_date(value):
            serialized = value.isoformat() if hasattr(value, "isoformat") else str(value)
            result[str(key)] = {"type": "date", "keyword": serialized, "date": serialized}
        else:
            result[str(key)] = {"type": "string", "keyword": str(value)}
    return result
