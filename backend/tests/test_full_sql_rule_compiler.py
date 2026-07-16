from app.services.rule_compiler import compile_rule_set


SCHEMA = [
    {"sourceName": "product_id", "targetName": "product_id", "type": "String", "included": True},
    {"sourceName": "category", "targetName": "category", "type": "String", "included": True},
    {"sourceName": "title", "targetName": "title", "type": "String", "included": True},
    {"sourceName": "price", "targetName": "price", "type": "Double", "included": True},
    {"sourceName": "average_rating", "targetName": "average_rating", "type": "Double", "included": True},
]

FULL_SQL_STEP = {
    "enabled": True,
    "id": "full-sql",
    "input": "title",
    "kind": "derive",
    "onError": "Warn",
    "operation": "SQL Expression",
    "output": "title",
    "params": "SELECT title, category, price, average_rating FROM input WHERE average_rating >= 4",
}


def test_full_sql_transform_uses_only_validated_output_schema() -> None:
    compiled = compile_rule_set(
        rules=None,
        transform_steps=[FULL_SQL_STEP],
        quality_rules=[],
        schema_columns=SCHEMA,
        transform_output_columns=[
            ["title", "String"],
            ["category", "String"],
            ["price", "Double"],
            ["average_rating", "Double"],
        ],
    )

    assert compiled.result.status == "pass"
    assert compiled.result.output_schema == [
        ("title", "String"),
        ("category", "String"),
        ("price", "Double"),
        ("average_rating", "Double"),
    ]


def test_full_sql_transform_requires_previewed_output_schema() -> None:
    compiled = compile_rule_set(
        rules=None,
        transform_steps=[FULL_SQL_STEP],
        quality_rules=[],
        schema_columns=SCHEMA,
        transform_output_columns=[],
    )

    assert compiled.result.status == "fail"
    assert any(issue.code == "RULE_OUTPUT_SCHEMA_REQUIRED" for issue in compiled.result.issues)
