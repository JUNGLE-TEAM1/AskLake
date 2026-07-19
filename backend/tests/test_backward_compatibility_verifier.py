from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-backward-compatibility.py"
SPEC = spec_from_file_location("verify_backward_compatibility", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
VERIFIER = module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def openapi_document(property_schema: dict, *, schemas: dict | None = None) -> dict:
    return {
        "openapi": "3.1.0",
        "paths": {},
        "components": {
            "schemas": {
                "AuditEntry": {
                    "type": "object",
                    "properties": {"targetType": property_schema},
                },
                **(schemas or {}),
            },
        },
    }


def compare(baseline: dict, current: dict) -> tuple[list[str], list[str]]:
    return VERIFIER.compare_openapi(baseline, current)


def test_inline_enum_and_equivalent_local_reference_are_compatible() -> None:
    values = ["dataset", "query_run"]
    baseline = openapi_document({"type": "string", "enum": values})
    current = openapi_document(
        {"$ref": "#/components/schemas/AuditTargetType"},
        schemas={"AuditTargetType": {"type": "string", "enum": values}},
    )

    breaking, additive = compare(baseline, current)

    assert breaking == []
    assert additive == ["new schema: AuditTargetType"]


def test_enum_value_addition_is_additive() -> None:
    baseline = openapi_document({"type": "string", "enum": ["dataset"]})
    current = openapi_document(
        {"$ref": "#/components/schemas/AuditTargetType"},
        schemas={"AuditTargetType": {"type": "string", "enum": ["dataset", "query_run"]}},
    )

    breaking, additive = compare(baseline, current)

    assert breaking == []
    assert "property enum values added: AuditEntry.targetType" in additive


def test_enum_value_removal_is_breaking() -> None:
    baseline = openapi_document({"type": "string", "enum": ["dataset", "query_run"]})
    current = openapi_document({"type": "string", "enum": ["dataset"]})

    breaking, _ = compare(baseline, current)

    assert breaking == ["property enum values removed: AuditEntry.targetType"]


def test_primitive_type_change_is_breaking() -> None:
    baseline = openapi_document({"type": "string"})
    current = openapi_document({"type": "integer"})

    breaking, _ = compare(baseline, current)

    assert breaking == ["property shape changed: AuditEntry.targetType"]


def test_unresolved_reference_fails_closed() -> None:
    baseline = openapi_document({"type": "string"})
    current = openapi_document({"$ref": "#/components/schemas/MissingType"})

    breaking, _ = compare(baseline, current)

    assert len(breaking) == 1
    assert breaking[0].startswith("property schema reference invalid: AuditEntry.targetType")
