#!/usr/bin/env python3
"""Validate that each production background control plane has one owner."""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import re
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / "deploy/control-plane-ownership.json"
IDENTIFIER = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
ALLOWED_PLATFORMS = {"eks", "ec2-compose"}
ALLOWED_EVIDENCE_KINDS = {"operator-declared", "repository"}


def load_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("control-plane ownership manifest must be a JSON object")
    return payload


def _strings(value: object, field: str, errors: list[str]) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        errors.append(f"{field} must be a non-empty string list")
        return []
    normalized = [item.strip() for item in value]
    if len(normalized) != len(set(normalized)):
        errors.append(f"{field} contains duplicate values")
    return normalized


def _validate_repository_reference(root: Path, reference: str, field: str, errors: list[str]) -> None:
    file_name, separator, marker = reference.partition("::")
    if not separator or not file_name or not marker:
        errors.append(f"{field} repository reference must use path::marker")
        return
    candidate = (root / file_name).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        errors.append(f"{field} repository reference escapes the repository")
        return
    if not candidate.is_file():
        errors.append(f"{field} repository file does not exist: {file_name}")
        return
    if marker not in candidate.read_text(encoding="utf-8", errors="replace"):
        errors.append(f"{field} repository marker is missing: {reference}")


def _validate_evidence(root: Path, evidence: object, field: str, errors: list[str]) -> None:
    if not isinstance(evidence, list) or not evidence:
        errors.append(f"{field} must contain evidence")
        return
    for index, item in enumerate(evidence):
        item_field = f"{field}[{index}]"
        if not isinstance(item, Mapping):
            errors.append(f"{item_field} must be an object")
            continue
        kind = str(item.get("kind") or "")
        reference = str(item.get("reference") or "").strip()
        if kind not in ALLOWED_EVIDENCE_KINDS:
            errors.append(f"{item_field}.kind is unsupported: {kind or '<missing>'}")
        if not reference:
            errors.append(f"{item_field}.reference is required")
        elif kind == "repository":
            _validate_repository_reference(root, reference, item_field, errors)


def _validate_control_planes(
    root: Path,
    value: object,
    errors: list[str],
) -> set[str]:
    if not isinstance(value, list) or not value:
        errors.append("requiredControlPlanes must be a non-empty list")
        return set()
    identifiers: set[str] = set()
    for index, item in enumerate(value):
        field = f"requiredControlPlanes[{index}]"
        if not isinstance(item, Mapping):
            errors.append(f"{field} must be an object")
            continue
        identifier = str(item.get("id") or "").strip()
        if not IDENTIFIER.fullmatch(identifier):
            errors.append(f"{field}.id must be a kebab-case identifier")
        elif identifier in identifiers:
            errors.append(f"duplicate control-plane id: {identifier}")
        else:
            identifiers.add(identifier)
        if item.get("ownerPolicy") != "exactly-one":
            errors.append(f"{field}.ownerPolicy must be exactly-one")
        entrypoints = _strings(item.get("entrypoints"), f"{field}.entrypoints", errors)
        for entrypoint in entrypoints:
            _validate_repository_reference(root, entrypoint, f"{field}.entrypoints", errors)
    return identifiers


def _validate_workloads(
    root: Path,
    value: object,
    control_planes: set[str],
    errors: list[str],
) -> tuple[dict[str, list[str]], set[str]]:
    claims = {identifier: [] for identifier in control_planes}
    active_platforms: set[str] = set()
    if not isinstance(value, list) or not value:
        errors.append("workloads must be a non-empty list")
        return claims, active_platforms
    identifiers: set[str] = set()
    cells: set[str] = set()
    for index, item in enumerate(value):
        field = f"workloads[{index}]"
        if not isinstance(item, Mapping):
            errors.append(f"{field} must be an object")
            continue
        identifier = str(item.get("id") or "").strip()
        cell = str(item.get("deploymentCell") or "").strip()
        platform = str(item.get("platform") or "").strip()
        active = item.get("active")
        if not IDENTIFIER.fullmatch(identifier) or identifier in identifiers:
            errors.append(f"{field}.id is missing, invalid, or duplicated")
        else:
            identifiers.add(identifier)
        if not IDENTIFIER.fullmatch(cell) or cell in cells:
            errors.append(f"{field}.deploymentCell is missing, invalid, or duplicated")
        else:
            cells.add(cell)
        if platform not in ALLOWED_PLATFORMS:
            errors.append(f"{field}.platform is unsupported: {platform or '<missing>'}")
        if not isinstance(active, bool):
            errors.append(f"{field}.active must be boolean")
        elif active:
            active_platforms.add(platform)
        _strings(item.get("responsibilities"), f"{field}.responsibilities", errors)
        owned = item.get("ownsControlPlanes")
        if not isinstance(owned, list) or not all(isinstance(value, str) and value.strip() for value in owned):
            errors.append(f"{field}.ownsControlPlanes must be a string list")
            owned = []
        if len(owned) != len(set(owned)):
            errors.append(f"{field}.ownsControlPlanes contains duplicate values")
        if active is False and owned:
            errors.append(f"{field} is inactive but still claims a control plane")
        for control_plane in owned:
            if control_plane not in control_planes:
                errors.append(f"{field} claims unknown control plane: {control_plane}")
            elif active is True:
                claims[control_plane].append(identifier)
        _validate_evidence(root, item.get("evidence"), f"{field}.evidence", errors)
    return claims, active_platforms


def validate_manifest(manifest: Mapping[str, Any], *, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    if manifest.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if manifest.get("environment") != "production":
        errors.append("environment must be production")
    if not str(manifest.get("contractOwner") or "").strip():
        errors.append("contractOwner is required")
    try:
        if date.fromisoformat(str(manifest.get("reviewBy") or "")) < date.today():
            errors.append("reviewBy is expired")
    except ValueError:
        errors.append("reviewBy must be an ISO date")

    required_platforms = set(_strings(manifest.get("requiredPlatforms"), "requiredPlatforms", errors))
    unknown_platforms = required_platforms - ALLOWED_PLATFORMS
    if unknown_platforms:
        errors.append(f"requiredPlatforms contains unsupported values: {', '.join(sorted(unknown_platforms))}")
    control_planes = _validate_control_planes(root, manifest.get("requiredControlPlanes"), errors)
    claims, active_platforms = _validate_workloads(root, manifest.get("workloads"), control_planes, errors)
    for control_plane, owners in sorted(claims.items()):
        if len(owners) != 1:
            errors.append(
                f"control plane {control_plane} requires exactly one active owner; found {len(owners)}"
            )
    missing_platforms = required_platforms - active_platforms
    if missing_platforms:
        errors.append(f"required active platforms are missing: {', '.join(sorted(missing_platforms))}")
    return sorted(set(errors))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    path = args.manifest.resolve()
    result_errors = validate_manifest(load_manifest(path), root=args.root.resolve())
    result = {"errors": result_errors, "manifest": str(path), "status": "fail" if result_errors else "pass"}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if result_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
