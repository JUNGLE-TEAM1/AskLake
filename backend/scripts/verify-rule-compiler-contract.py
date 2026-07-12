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


def main() -> None:
    pass_through = compile_rule_set(
        rules=[],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
    )
    assert pass_through.result.status == "pass"
    assert pass_through.result.output_schema == [("review", "String"), ("raw_amount", "Double")]

    legacy = compile_rule_set(
        rules=[],
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
        rules=legacy.result.rules[:1],
        transform_steps=[],
        quality_rules=[],
        schema_columns=SCHEMA,
        execution_mode="continuous",
        source_type="Stream / Kafka",
    )
    assert "RULE_EXECUTION_MODE_UNSUPPORTED" in issue_codes(continuous)

    kafka_sql = compile_rule_set(
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

    invalid_review = review_request.model_copy(update={"rules": unsupported.result.rules})
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
