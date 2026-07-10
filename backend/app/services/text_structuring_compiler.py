import hashlib
import json
from typing import Any

from app.schemas.text_structuring import (
    TextFieldSpec,
    TextRepeatedGroupSpec,
    TextStructuringDefinition,
)

PROMPT_VERSION = "text-structuring-v2"


def definition_fingerprint(definition: TextStructuringDefinition) -> str:
    canonical = json.dumps(
        definition.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compile_definition(definition: TextStructuringDefinition) -> dict[str, Any]:
    output_properties = {
        field.target_name: field_json_schema(field)
        for field in definition.fields
    }
    repeated_properties = {
        group.target_name: repeated_group_json_schema(group)
        for group in definition.repeated_groups
    }
    return {
        "type": "object",
        "properties": {
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "sourceRowId": {"type": "string"},
                        "output": strict_object(output_properties),
                        "repeatedGroups": strict_object(repeated_properties),
                    },
                    "required": ["sourceRowId", "output", "repeatedGroups"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["rows"],
        "additionalProperties": False,
    }


def strict_object(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def repeated_group_json_schema(group: TextRepeatedGroupSpec) -> dict[str, Any]:
    return {
        "type": "array",
        "items": strict_object({field.target_name: field_json_schema(field) for field in group.fields}),
    }


def field_json_schema(field: TextFieldSpec) -> dict[str, Any]:
    schema = base_field_json_schema(field)
    if field.description:
        schema = {**schema, "description": field.description}
    if field.nullable:
        return {"anyOf": [schema, {"type": "null"}]}
    return schema


def base_field_json_schema(field: TextFieldSpec) -> dict[str, Any]:
    values = [label.value for label in field.allowed_values]
    if field.task == "multi_label":
        item_schema: dict[str, Any] = {"type": "string"}
        if values:
            item_schema["enum"] = values
        return {"type": "array", "items": item_schema, "uniqueItems": True}
    if field.task == "boolean" or field.output_type.casefold() in {"bool", "boolean"}:
        return {"type": "boolean"}
    if field.task == "extract_scalar" or any(
        token in field.output_type.casefold()
        for token in ("int", "float", "double", "decimal", "number")
    ):
        return {"type": "number"}
    schema: dict[str, Any] = {"type": "string"}
    if values:
        schema["enum"] = values
    return schema


def build_system_instructions(definition: TextStructuringDefinition) -> str:
    field_contracts = []
    for field in definition.fields:
        field_contracts.append(field_instruction(field))
    for group in definition.repeated_groups:
        children = "; ".join(field_instruction(field) for field in group.fields)
        field_contracts.append(
            f"Repeated group {group.target_name}: {group.description}. Emit one item per distinct aspect or fact. "
            f"Do not merge conflicting aspects. Fields: {children}"
        )
    return "\n".join(
        [
            "Convert each input row into the exact supplied JSON schema.",
            "Treat every row independently and preserve sourceRowId exactly.",
            "A single text may express different sentiment or severity for different aspects. Keep those as separate repeated-group items.",
            "Use only configured enum values. Use the configured unknown/null representation when evidence is insufficient.",
            "Negation, contrast, sarcasm, and quoted text must be interpreted in context; keyword presence alone is not a decision.",
            "Evidence fields must contain a short span copied from the input, never an invented quotation.",
            "Return JSON only.",
            *field_contracts,
        ]
    )


def field_instruction(field: TextFieldSpec) -> str:
    allowed = ", ".join(
        f"{label.value} ({label.description})" if label.description else label.value
        for label in field.allowed_values
    )
    suffix = f" Allowed values: {allowed}." if allowed else ""
    source = f" Copy only from {field.source_field}." if field.task == "copy" and field.source_field else ""
    examples = ""
    if field.examples:
        rendered = [
            f"{example.text!r} -> {json.dumps(example.value, ensure_ascii=False)}"
            for example in field.examples[:5]
        ]
        examples = f" Examples: {'; '.join(rendered)}."
    return (
        f"Field {field.target_name} [{field.task}, {field.output_type}]: {field.description}."
        f"{suffix}{source}{examples}"
    )
