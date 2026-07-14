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


def typed_metadata_filter(metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Encode exact and range-friendly metadata without losing display values."""
    result: dict[str, dict[str, Any]] = {}
    for key, value in metadata.items():
        if isinstance(value, bool):
            result[str(key)] = {"type": "boolean", "keyword": "true" if value else "false", "boolean": value}
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            result[str(key)] = {"type": "number", "keyword": str(value), "number": float(value)}
        elif _is_iso_date(value):
            serialized = value.isoformat() if hasattr(value, "isoformat") else str(value)
            result[str(key)] = {"type": "date", "keyword": serialized, "date": serialized}
        else:
            result[str(key)] = {"type": "string", "keyword": str(value)}
    return result
