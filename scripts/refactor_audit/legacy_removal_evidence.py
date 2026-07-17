#!/usr/bin/env python3
"""Fail closed unless production compatibility removal has measured evidence."""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "docs/refactor-2026/legacy-removal-evidence.json"
DEFAULT_REGISTER = ROOT / "docs/refactor-2026/legacy-path-register.json"
OBSERVATION_STATUSES = {"not_started", "collecting", "passed", "failed"}
APPROVAL_STATUSES = {"not_requested", "approved", "rejected"}
EVIDENCE_KINDS = {"dashboard-export", "log-query", "release-record"}


def load_document(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return payload


def _parse_date(value: object, field: str, errors: list[str]) -> date | None:
    if not isinstance(value, str):
        errors.append(f"{field} must be an ISO date")
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        errors.append(f"{field} must be an ISO date")
        return None


def _production_owners(register: Mapping[str, Any], errors: list[str]) -> dict[str, str]:
    entries = register.get("entries")
    if not isinstance(entries, list):
        errors.append("legacy register entries must be a list")
        return {}
    owners: dict[str, str] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, Mapping) or entry.get("reachability") != "production":
            continue
        path_id = str(entry.get("id") or "").strip()
        owner = str(entry.get("owner") or "").strip()
        if not path_id or not owner:
            errors.append(f"legacy register production entry {index} needs id and owner")
            continue
        if path_id in owners:
            errors.append(f"legacy register has duplicate production path: {path_id}")
            continue
        owners[path_id] = owner
    return owners


def _validate_evidence(value: object, field: str, errors: list[str]) -> int:
    if not isinstance(value, list):
        errors.append(f"{field} must be a list")
        return 0
    references: set[str] = set()
    valid_count = 0
    for index, item in enumerate(value):
        item_field = f"{field}[{index}]"
        if not isinstance(item, Mapping):
            errors.append(f"{item_field} must be an object")
            continue
        kind = str(item.get("kind") or "").strip()
        reference = str(item.get("reference") or "").strip()
        if kind not in EVIDENCE_KINDS:
            errors.append(f"{item_field}.kind is unsupported: {kind or '<missing>'}")
        if not reference:
            errors.append(f"{item_field}.reference is required")
        elif reference in references:
            errors.append(f"{field} has duplicate reference: {reference}")
        else:
            references.add(reference)
        if kind in EVIDENCE_KINDS and reference:
            valid_count += 1
    return valid_count


def _validate_observation(
    path_id: str,
    value: object,
    minimum_days: int,
    errors: list[str],
) -> tuple[str, bool]:
    field = f"paths[{path_id}].observation"
    if not isinstance(value, Mapping):
        errors.append(f"{field} must be an object")
        return "", False
    before = len(errors)
    status = str(value.get("status") or "").strip()
    start_value = value.get("windowStart")
    end_value = value.get("windowEnd")
    observed_calls = value.get("observedCalls")
    evidence_count = _validate_evidence(value.get("evidence"), f"{field}.evidence", errors)
    if status not in OBSERVATION_STATUSES:
        errors.append(f"{field}.status is unsupported: {status or '<missing>'}")
        return status, False

    if status == "not_started":
        if any(value is not None for value in (start_value, end_value, observed_calls)) or evidence_count:
            errors.append(f"{field} not_started state must not claim a window, calls, or evidence")
    elif status == "collecting":
        _parse_date(start_value, f"{field}.windowStart", errors)
        if end_value is not None or observed_calls is not None:
            errors.append(f"{field} collecting state must not claim a completed window or call count")
        if evidence_count == 0:
            errors.append(f"{field} collecting state requires an observation reference")
    else:
        start = _parse_date(start_value, f"{field}.windowStart", errors)
        end = _parse_date(end_value, f"{field}.windowEnd", errors)
        if evidence_count == 0:
            errors.append(f"{field} {status} state requires evidence")
        if not isinstance(observed_calls, int) or isinstance(observed_calls, bool) or observed_calls < 0:
            errors.append(f"{field}.observedCalls must be a non-negative integer")
        if start is not None and end is not None:
            if end < start:
                errors.append(f"{field} windowEnd must not precede windowStart")
            elif status == "passed" and (end - start).days < minimum_days:
                errors.append(f"{field} passed window must cover at least {minimum_days} days")
        if status == "passed" and observed_calls != 0:
            errors.append(f"{field} passed state requires zero observed calls")
        if status == "failed" and (
            not isinstance(observed_calls, int)
            or isinstance(observed_calls, bool)
            or observed_calls <= 0
        ):
            errors.append(f"{field} failed state requires at least one observed call")
    return status, status == "passed" and len(errors) == before


def _validate_approval(
    path_id: str,
    value: object,
    observation_passed: bool,
    errors: list[str],
) -> bool:
    field = f"paths[{path_id}].approval"
    if not isinstance(value, Mapping):
        errors.append(f"{field} must be an object")
        return False
    before = len(errors)
    status = str(value.get("status") or "").strip()
    reviewed_at = value.get("reviewedAt")
    reviewed_by = value.get("reviewedBy")
    reference = value.get("reference")
    if status not in APPROVAL_STATUSES:
        errors.append(f"{field}.status is unsupported: {status or '<missing>'}")
        return False
    if status == "not_requested":
        if any(item is not None for item in (reviewed_at, reviewed_by, reference)):
            errors.append(f"{field} not_requested state must not claim review evidence")
        return False
    _parse_date(reviewed_at, f"{field}.reviewedAt", errors)
    if not isinstance(reviewed_by, str) or not reviewed_by.strip():
        errors.append(f"{field}.reviewedBy is required")
    if not isinstance(reference, str) or not reference.strip():
        errors.append(f"{field}.reference is required")
    if status == "approved" and not observation_passed:
        errors.append(f"{field} cannot be approved before a valid zero-call observation passes")
    return status == "approved" and observation_passed and len(errors) == before


def validate_documents(
    manifest: Mapping[str, Any],
    register: Mapping[str, Any],
) -> tuple[list[str], list[str], int]:
    errors: list[str] = []
    if manifest.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if manifest.get("environment") != "production":
        errors.append("environment must be production")
    minimum_days = manifest.get("minimumZeroCallDays")
    if not isinstance(minimum_days, int) or isinstance(minimum_days, bool) or minimum_days < 30:
        errors.append("minimumZeroCallDays must be an integer of at least 30")
        minimum_days = 30

    production_owners = _production_owners(register, errors)
    entries = manifest.get("paths")
    if not isinstance(entries, list):
        errors.append("paths must be a list")
        return sorted(set(errors)), [], len(production_owners)

    seen: set[str] = set()
    eligible: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            errors.append(f"paths[{index}] must be an object")
            continue
        path_id = str(entry.get("pathId") or "").strip()
        if not path_id:
            errors.append(f"paths[{index}].pathId is required")
            continue
        if path_id in seen:
            errors.append(f"duplicate evidence path: {path_id}")
        seen.add(path_id)
        expected_owner = production_owners.get(path_id)
        if expected_owner is None:
            errors.append(f"evidence path is not production-registered: {path_id}")
        elif entry.get("owner") != expected_owner:
            errors.append(f"owner drift for {path_id}: expected {expected_owner}")
        _, observation_passed = _validate_observation(
            path_id,
            entry.get("observation"),
            minimum_days,
            errors,
        )
        approved = _validate_approval(path_id, entry.get("approval"), observation_passed, errors)
        if approved and expected_owner is not None:
            eligible.append(path_id)

    missing = set(production_owners) - seen
    if missing:
        errors.append(f"production paths missing removal evidence: {', '.join(sorted(missing))}")
    return sorted(set(errors)), sorted(set(eligible)), len(production_owners)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--register", type=Path, default=DEFAULT_REGISTER)
    args = parser.parse_args()
    try:
        manifest = load_document(args.manifest)
        register = load_document(args.register)
        errors, eligible, production_count = validate_documents(manifest, register)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        errors, eligible, production_count = [str(error)], [], 0
    result = {
        "blockedPathCount": max(production_count - len(eligible), 0),
        "eligiblePathCount": len(eligible),
        "eligiblePaths": eligible,
        "errors": errors,
        "productionPathCount": production_count,
        "status": "fail" if errors else "pass",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
