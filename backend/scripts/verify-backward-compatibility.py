#!/usr/bin/env python3
"""Fail when the staged refactor removes a baseline API or persisted contract."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Mapping


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
BASELINE_DIR = ROOT / "docs/refactor-2026/baseline/artifacts"


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected an object in {path}")
    return payload


def operation_items(document: Mapping[str, Any]) -> Iterable[tuple[str, str, Mapping[str, Any]]]:
    for path, path_item in document.get("paths", {}).items():
        if not isinstance(path_item, Mapping):
            continue
        for method, operation in path_item.items():
            if method.casefold() not in {"delete", "get", "head", "options", "patch", "post", "put"}:
                continue
            if isinstance(operation, Mapping):
                yield str(path), method.casefold(), operation


def schema_refs(value: Any) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, Mapping):
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/components/schemas/"):
            refs.add(reference.rsplit("/", 1)[-1])
        for nested in value.values():
            refs.update(schema_refs(nested))
    elif isinstance(value, list):
        for nested in value:
            refs.update(schema_refs(nested))
    return refs


def request_schema_names(document: Mapping[str, Any]) -> set[str]:
    schemas = document.get("components", {}).get("schemas", {})
    pending: list[str] = []
    for _, _, operation in operation_items(document):
        pending.extend(schema_refs(operation.get("requestBody")))
        pending.extend(schema_refs(operation.get("parameters")))
    discovered: set[str] = set()
    while pending:
        name = pending.pop()
        if name in discovered:
            continue
        discovered.add(name)
        pending.extend(schema_refs(schemas.get(name, {})))
    return discovered


class SchemaReferenceError(ValueError):
    """Raised when an OpenAPI schema reference cannot be resolved safely."""


def resolve_local_schema(
    value: Mapping[str, Any],
    document: Mapping[str, Any],
    references: tuple[str, ...] = (),
) -> Mapping[str, Any]:
    reference = value.get("$ref")
    if not isinstance(reference, str):
        return value
    if not reference.startswith("#/"):
        raise SchemaReferenceError(f"unsupported schema reference: {reference}")
    if reference in references:
        raise SchemaReferenceError(f"cyclic schema reference: {reference}")

    resolved: Any = document
    for raw_token in reference[2:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if not isinstance(resolved, Mapping) or token not in resolved:
            raise SchemaReferenceError(f"unresolved schema reference: {reference}")
        resolved = resolved[token]
    if not isinstance(resolved, Mapping):
        raise SchemaReferenceError(f"schema reference is not an object: {reference}")

    canonical = dict(resolve_local_schema(resolved, document, (*references, reference)))
    canonical.update({key: nested for key, nested in value.items() if key != "$ref"})
    return canonical


def property_shape(value: Mapping[str, Any], document: Mapping[str, Any]) -> tuple[Any, ...]:
    resolved = resolve_local_schema(value, document)
    return (
        resolved.get("type"),
        resolved.get("format"),
        resolved.get("nullable"),
        property_shape(resolved["items"], document) if isinstance(resolved.get("items"), Mapping) else None,
        tuple(
            property_shape(item, document)
            for item in resolved.get("allOf", [])
            if isinstance(item, Mapping)
        ),
        tuple(
            property_shape(item, document)
            for item in resolved.get("anyOf", [])
            if isinstance(item, Mapping)
        ),
        tuple(
            property_shape(item, document)
            for item in resolved.get("oneOf", [])
            if isinstance(item, Mapping)
        ),
    )


def schema_enum(value: Mapping[str, Any], document: Mapping[str, Any]) -> set[Any]:
    return set(resolve_local_schema(value, document).get("enum", []))


def compare_openapi(baseline: Mapping[str, Any], current: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    breaking: list[str] = []
    additive: list[str] = []
    baseline_operations = {(path, method): operation for path, method, operation in operation_items(baseline)}
    current_operations = {(path, method): operation for path, method, operation in operation_items(current)}

    for key, old_operation in baseline_operations.items():
        new_operation = current_operations.get(key)
        label = f"{key[1].upper()} {key[0]}"
        if new_operation is None:
            breaking.append(f"removed operation: {label}")
            continue
        old_responses = set(old_operation.get("responses", {}))
        new_responses = set(new_operation.get("responses", {}))
        for response in sorted(old_responses - new_responses):
            breaking.append(f"removed response {response}: {label}")

        old_parameters = {
            (str(item.get("in")), str(item.get("name"))): item
            for item in old_operation.get("parameters", [])
            if isinstance(item, Mapping)
        }
        new_parameters = {
            (str(item.get("in")), str(item.get("name"))): item
            for item in new_operation.get("parameters", [])
            if isinstance(item, Mapping)
        }
        for parameter, old_value in old_parameters.items():
            new_value = new_parameters.get(parameter)
            if new_value is None:
                breaking.append(f"removed parameter {parameter}: {label}")
            elif not old_value.get("required") and new_value.get("required"):
                breaking.append(f"parameter became required {parameter}: {label}")
        for parameter, new_value in new_parameters.items():
            if parameter not in old_parameters and new_value.get("required"):
                breaking.append(f"new required parameter {parameter}: {label}")

    for key in sorted(set(current_operations) - set(baseline_operations)):
        additive.append(f"new operation: {key[1].upper()} {key[0]}")

    old_schemas = baseline.get("components", {}).get("schemas", {})
    new_schemas = current.get("components", {}).get("schemas", {})
    request_schemas = request_schema_names(current)
    for name, old_schema in old_schemas.items():
        new_schema = new_schemas.get(name)
        if not isinstance(new_schema, Mapping):
            breaking.append(f"removed schema: {name}")
            continue
        if old_schema.get("type") != new_schema.get("type"):
            breaking.append(f"schema type changed: {name}")
        old_enum = set(old_schema.get("enum", []))
        new_enum = set(new_schema.get("enum", []))
        if not old_enum.issubset(new_enum):
            breaking.append(f"schema enum values removed: {name}")
        old_properties = old_schema.get("properties", {})
        new_properties = new_schema.get("properties", {})
        for property_name, old_property in old_properties.items():
            new_property = new_properties.get(property_name)
            if not isinstance(new_property, Mapping):
                breaking.append(f"removed property: {name}.{property_name}")
            else:
                try:
                    old_shape = property_shape(old_property, baseline)
                    new_shape = property_shape(new_property, current)
                    old_property_enum = schema_enum(old_property, baseline)
                    new_property_enum = schema_enum(new_property, current)
                except SchemaReferenceError as error:
                    breaking.append(f"property schema reference invalid: {name}.{property_name} ({error})")
                    continue
                if old_shape != new_shape:
                    breaking.append(f"property shape changed: {name}.{property_name}")
                elif not old_property_enum.issubset(new_property_enum):
                    breaking.append(f"property enum values removed: {name}.{property_name}")
                elif new_property_enum - old_property_enum:
                    additive.append(f"property enum values added: {name}.{property_name}")
        new_required = set(new_schema.get("required", [])) - set(old_schema.get("required", []))
        if new_required:
            message = f"new required fields: {name} ({', '.join(sorted(new_required))})"
            if name in request_schemas:
                breaking.append(message)
            else:
                additive.append(message)

    for name in sorted(set(new_schemas) - set(old_schemas)):
        additive.append(f"new schema: {name}")
    return breaking, additive


def compare_persisted_contracts(baseline: Mapping[str, Any], current: Mapping[str, Any]) -> list[str]:
    breaking: list[str] = []
    old_models = baseline.get("models", {})
    new_models = current.get("models", {})
    old_tables = {item["table"] for item in old_models.get("tables", [])}
    new_tables = {item["table"] for item in new_models.get("tables", [])}
    for table in sorted(old_tables - new_tables):
        breaking.append(f"removed persisted table model: {table}")
    for schema in sorted(set(old_models.get("schema_classes", [])) - set(new_models.get("schema_classes", []))):
        breaking.append(f"removed persisted/API schema class: {schema}")
    for name, old_values in old_models.get("literal_contracts", {}).items():
        new_values = set(new_models.get("literal_contracts", {}).get(name, []))
        removed = set(old_values) - new_values
        if removed:
            breaking.append(f"removed literal values from {name}: {sorted(removed, key=str)}")
    for migration in sorted(set(old_models.get("migration_files", [])) - set(new_models.get("migration_files", []))):
        breaking.append(f"removed migration: {migration}")
    return breaking


def compare_frontend_contracts(baseline: Mapping[str, Any]) -> list[str]:
    breaking: list[str] = []
    sources = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in sorted((ROOT / "frontend/src").rglob("*"))
        if path.is_file() and path.suffix in {".js", ".jsx", ".ts", ".tsx"}
    )
    for route in baseline.get("frontend", {}).get("route_literals", []):
        pattern = re.compile(rf"[\"']{re.escape(route)}[\"']")
        if not pattern.search(sources):
            breaking.append(f"removed frontend route literal: {route}")
    shell = (ROOT / "frontend/src/data/appShellData.ts").read_text(encoding="utf-8")
    for flow in baseline.get("frontend", {}).get("wizard_flows", []):
        if not re.search(rf"[\"']{re.escape(flow)}[\"']", shell):
            breaking.append(f"removed wizard flow: {flow}")
    return breaking


def main() -> int:
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(BACKEND))
    from app.main import app  # pylint: disable=import-outside-toplevel
    from scripts.refactor_audit.collect_baseline import model_contracts  # pylint: disable=import-outside-toplevel

    baseline_openapi = load_json(BASELINE_DIR / "openapi.json")
    current_openapi = app.openapi()
    baseline_contracts = load_json(BASELINE_DIR / "contracts.json")
    current_contracts = {"models": model_contracts()}

    breaking, additive = compare_openapi(baseline_openapi, current_openapi)
    breaking.extend(compare_persisted_contracts(baseline_contracts, current_contracts))
    breaking.extend(compare_frontend_contracts(baseline_contracts))

    print(
        json.dumps(
            {
                "additiveChanges": sorted(additive),
                "baselineOperations": sum(1 for _ in operation_items(baseline_openapi)),
                "breakingChanges": sorted(breaking),
                "currentOperations": sum(1 for _ in operation_items(current_openapi)),
                "status": "fail" if breaking else "pass",
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 1 if breaking else 0


if __name__ == "__main__":
    raise SystemExit(main())
