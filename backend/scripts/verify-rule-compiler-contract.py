import json
from pathlib import Path

from app.core.errors import ApiError
from app.schemas.etl import CanonicalRuleDraft, QualityRuleDraft, ReviewPipelineRequest, SchemaColumnDraft, TransformStepDraft
from app.services import etl_service
from app.services.rule_compiler import compile_rule_set


SCHEMA = [
    SchemaColumnDraft(source_name="review", target_name="review", type="String", nullable=False),
    SchemaColumnDraft(source_name="raw.amount", target_name="raw_amount", type="Double", nullable=True),
]


def issue_codes(compiled):
    return {issue.code for issue in compiled.result.issues}


def verify_shared_conformance() -> None:
    fixture_path = Path(__file__).resolve().parents[1] / "fixtures" / "rules" / "rule-compiler-conformance.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    schema_columns = [SchemaColumnDraft.model_validate(column) for column in fixture["schemaColumns"]]
    for case in fixture["cases"]:
        request = case["request"]
        canonical_supplied = "rules" in request
        compiled = compile_rule_set(
            contract_version=request.get("ruleContractVersion"),
            rules=[CanonicalRuleDraft.model_validate(rule) for rule in request.get("rules", [])] if canonical_supplied else None,
            transform_steps=request.get("transformSteps", []),
            quality_rules=request.get("qualityRules", []),
            schema_columns=schema_columns,
            transform_output_columns=request.get("transformOutputColumns", []),
            execution_mode=request.get("executionMode", "snapshot"),
            source_type=request.get("sourceType", "File / S3"),
        )
        actual_codes = sorted(issue_codes(compiled))
        assert compiled.result.status == case["expectedStatus"], case["name"]
        assert actual_codes == sorted(case["expectedIssueCodes"]), (case["name"], actual_codes)
        if "expectedOutputSchema" in case:
            assert [list(column) for column in compiled.result.output_schema] == case["expectedOutputSchema"], case["name"]


def main() -> None:
    verify_shared_conformance()
    pass_through = compile_rule_set(
        contract_version="1.0",
        rules=[],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert pass_through.result.status == "pass"
    assert pass_through.result.output_schema == [("review", "String"), ("raw_amount", "Double")]

    legacy = compile_rule_set(
        rules=None,
        transform_steps=[TransformStepDraft(
            id="normalize-review",
            input="review",
            kind="trim",
            label="normalize",
            on_error="Drop Row",
            operation="Lowercase + Trim",
            output="normalized_review",
        )],
        quality_rules=[QualityRuleDraft(
            failure_action="Quarantine",
            id="valid-review",
            kind="regex",
            params='{"pattern":"^ok"}',
            severity="Error",
            target_column="normalized_review",
            validation_type="Regex Match",
        )],
        schema_columns=SCHEMA,
        transform_output_columns=[("normalized_review", "String")],
        execution_mode="snapshot",
        source_type="File / S3",
    )
    assert legacy.result.status == "pass"
    assert [rule.operation for rule in legacy.result.rules] == ["lowercase_trim", "regex"]
    assert legacy.result.rules[0].on_error == "warn"
    assert legacy.result.rules[0].failure_disposition == "drop_row"
    assert legacy.transform_steps[0].on_error == "Drop Row"
    assert legacy.quality_rules[0].failure_action == "Quarantine"
    assert legacy.result.output_schema[-1] == ("normalized_review", "String")

    canonical = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="cast-amount",
            input_columns=["raw.amount"],
            kind="transform",
            on_error="fail_batch",
            operation="cast",
            output_columns=["amount"],
            output_type="Double",
            parameters={"targetType": "Double"},
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
        execution_mode="snapshot",
        source_type="Stream / Kafka",
    )
    assert canonical.result.status == "pass"
    assert canonical.transform_steps[0].operation == "Cast Double"
    assert canonical.transform_steps[0].on_error == "Fail Run"
    assert canonical.result.output_schema[-1] == ("amount", "Double")

    missing_input = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="missing-input",
            input_columns=["absent"],
            kind="transform",
            operation="mask",
            output_columns=["masked"],
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_INPUT_NOT_FOUND" in issue_codes(missing_input)

    unsupported = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="aggregate",
            input_columns=["raw.amount"],
            kind="transform",
            operation="group_by_sum",
            output_columns=["total"],
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_OPERATION_UNSUPPORTED" in issue_codes(unsupported)

    unique_rule = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="unique-review",
            input_columns=["review"],
            kind="quality",
            operation="unique",
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_OPERATION_UNSUPPORTED" in issue_codes(unique_rule)

    continuous = compile_rule_set(
        contract_version="1.0",
        rules=legacy.result.rules[:1],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
        execution_mode="continuous",
        source_type="Stream / Kafka",
    )
    assert "RULE_EXECUTION_MODE_UNSUPPORTED" in issue_codes(continuous)

    kafka_sql = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="sql-expression",
            input_columns=["review"],
            kind="transform",
            operation="sql_expression",
            output_columns=["derived"],
            parameters={"expression": "upper(review)"},
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
        execution_mode="snapshot",
        source_type="Stream / Kafka",
    )
    assert "RULE_EXECUTION_MODE_UNSUPPORTED" in issue_codes(kafka_sql)

    for value in (0, False, "", None):
        first = compile_rule_set(
            contract_version="1.0",
            rules=[CanonicalRuleDraft(
                id=f"default-{value!r}",
                input_columns=["raw.amount"],
                kind="transform",
                operation="default_value",
                output_columns=["raw_amount"],
                output_type="Double",
                parameters={"value": value},
            )],
            transform_steps=[],
            quality_rules=[],
            schema_columns=SCHEMA,
        )
        round_trip = compile_rule_set(
            rules=None,
            transform_steps=first.transform_steps,
            quality_rules=first.quality_rules,
            schema_columns=SCHEMA,
            transform_output_columns=first.result.output_schema,
        )
        assert round_trip.result.rules[0].parameters == {"value": value}

    policy_conflict = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="policy-conflict",
            input_columns=["review"],
            kind="quality",
            on_error="quarantine",
            failure_disposition="drop_row",
            operation="not_null",
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_FAILURE_POLICY_CONFLICT" in issue_codes(policy_conflict)

    future_version = compile_rule_set(
        contract_version="2.0",
        rules=[CanonicalRuleDraft(
            contract_version="2.0",
            id="future-version",
            input_columns=["review"],
            kind="transform",
            operation="copy",
            output_columns=["review_copy"],
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_CONTRACT_VERSION_UNSUPPORTED" in issue_codes(future_version)

    missing_version = compile_rule_set(
        rules=[CanonicalRuleDraft(
            id="missing-version",
            input_columns=["review"],
            kind="transform",
            operation="copy",
            output_columns=["review_copy"],
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_CONTRACT_VERSION_REQUIRED" in issue_codes(missing_version)

    invalid_shape = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="invalid-shape",
            input_columns=["review"],
            kind="future",
            on_error="ignore",
            failure_disposition="discard",
            operation="copy",
            output_columns=["review_copy"],
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert {"RULE_KIND_UNSUPPORTED", "RULE_ERROR_POLICY_UNSUPPORTED", "RULE_FAILURE_DISPOSITION_UNSUPPORTED"} <= issue_codes(invalid_shape)

    unsupported_parameter = compile_rule_set(
        contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="unsupported-parameter",
            input_columns=["review"],
            kind="transform",
            operation="copy",
            output_columns=["review_copy"],
            parameters={"extra": True},
        )],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert "RULE_PARAMETER_UNSUPPORTED" in issue_codes(unsupported_parameter)

    explicit_empty = compile_rule_set(
        contract_version="1.0",
        rules=[],
        transform_steps=legacy.transform_steps,
        quality_rules=legacy.quality_rules,
        schema_columns=SCHEMA,
    )
    assert explicit_empty.result.rules == []

    review_request = ReviewPipelineRequest(
        id="rule-review",
        job_name="rule_review_pipeline",
        owner="data-team-01",
        permission_summary="Data Engineer Group",
        rule_summary="",
        schedule_label="스케줄링 건너뛰기",
        schema_columns=SCHEMA,
        source_connection_status="success",
        source_label="SQL preview",
        source_type="SQL Result",
        target_dataset="rule_review",
        target_format="parquet",
        target_layer="SILVER",
    )
    review = etl_service.review_pipeline(review_request)
    assert review.can_create is True, "Rule-free Jobs must compile as pass-through."
    assert review.rule_compilation.status == "pass"
    assert any(row.label == "처리 규칙" and row.value == "pass-through" for row in review.validation)

    invalid_review = review_request.model_copy(update={"rule_contract_version": "1.0", "rules": unsupported.result.rules})
    invalid_result = etl_service.review_pipeline(invalid_review)
    assert invalid_result.can_create is False
    assert invalid_result.rule_compilation.status == "fail"
    try:
        etl_service.require_compiled_rules(unsupported)
    except ApiError as exc:
        assert exc.status_code == 400
        assert exc.code == "RULE_COMPILATION_FAILED"
        assert exc.details["issues"][0]["code"] == "RULE_OPERATION_UNSUPPORTED"
    else:
        raise AssertionError("Create/update must reject failed rule compilation.")

    print("verify-rule-compiler-contract: ok")


if __name__ == "__main__":
    main()
