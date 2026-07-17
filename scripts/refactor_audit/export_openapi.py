#!/usr/bin/env python3
"""Export the FastAPI OpenAPI contract without starting network services."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
OUTPUT = ROOT / "docs/refactor-2026/baseline/artifacts/openapi.json"


def main() -> int:
    sys.path.insert(0, str(BACKEND))
    from app.main import app  # pylint: disable=import-outside-toplevel

    payload = app.openapi()
    payload.pop("servers", None)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(OUTPUT.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
