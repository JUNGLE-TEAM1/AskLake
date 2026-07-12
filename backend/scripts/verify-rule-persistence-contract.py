from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.models.base import Base
from app.models.etl import ETLJobModel
from app.repositories import etl_repository
from app.schemas.etl import CreatePipelineRequest, UpdatePipelineRequest
from app.services import etl_service


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs) -> str:
    return "JSON"


def main() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    etl_repository._schema_ready_bind_ids.add(id(engine))
    with Session(engine) as db:
        create_request = CreatePipelineRequest.model_validate(create_payload(0))
        created = etl_service.create_pipeline(db, create_request, "admin")
        job_id = created.job.id
        expected_created_rule = create_request.rules[0].model_dump(mode="json", by_alias=True)
        assert created.job.rule_contract_version == "1.0"
        assert created.job.rules[0].model_dump(mode="json", by_alias=True) == expected_created_rule

        stored = etl_repository.get_job(db, job_id)
        assert stored is not None
        assert stored.rule_contract_version == "1.0"
        assert stored.rules == [expected_created_rule]
        hydrated = etl_repository.get_job_schema(db, job_id)
        assert hydrated is not None
        assert hydrated.rules[0].parameters == {"value": 0}

        update_request = UpdatePipelineRequest.model_validate(update_payload(False))
        updated = etl_service.update_pipeline(
            db,
            job_id,
            update_request,
            ActorContext(name="admin", role="admin"),
        )
        expected_updated_rule = update_request.rules[0].model_dump(mode="json", by_alias=True)
        assert updated.rules[0].model_dump(mode="json", by_alias=True) == expected_updated_rule
        stored = etl_repository.get_job(db, job_id)
        assert stored is not None
        assert stored.rules == [expected_updated_rule]
        assert etl_repository.get_job_schema(db, job_id).rules[0].parameters == {"value": False}

        legacy = legacy_job("JOB-RULE-LEGACY", "legacy_target", rule_contract_version=None, rules=None)
        legacy_response = etl_repository.create_job(db, legacy)
        assert legacy_response.rules[0].parameters == {"value": "legacy"}

        explicit_empty = legacy_job("JOB-RULE-EMPTY", "empty_target", rule_contract_version="1.0", rules=[])
        explicit_empty_response = etl_repository.create_job(db, explicit_empty)
        assert explicit_empty_response.rules == []
        assert explicit_empty_response.rule_compilation.status == "pass"

    print("verify-rule-persistence-contract: ok")


def create_payload(default_value):
    return {
        "id": "rule-persistence",
        "jobName": "rule_persistence_pipeline",
        "owner": "data-team-01",
        "permissionSummary": "Data Engineer Group",
        "ruleContractVersion": "1.0",
        "rules": [canonical_default_rule(default_value)],
        "ruleSummary": "default rule",
        "scheduleLabel": "스케줄링 건너뛰기",
        "schemaColumns": schema_columns(),
        "schemaSampleRows": [["4.5"]],
        "schemaSummary": "1개 필드",
        "sourceConfig": [],
        "sourceLabel": "Rule fixture",
        "sourceType": "SQL Result",
        "targetDataset": "rule_persistence_target",
        "targetFormat": "parquet",
        "targetLayer": "SILVER",
    }


def update_payload(default_value):
    payload = create_payload(default_value)
    for key in ("id", "sourceConfig", "sourceLabel", "sourceType"):
        payload.pop(key)
    return payload


def canonical_default_rule(value):
    return {
        "contractVersion": "1.0",
        "enabled": True,
        "failureDisposition": "keep",
        "id": "rating-default",
        "inputColumns": ["rating"],
        "kind": "transform",
        "onError": "warn",
        "operation": "default_value",
        "outputColumns": ["rating"],
        "outputType": "Double",
        "parameters": {"value": value},
    }


def schema_columns():
    return [{
        "included": True,
        "nullable": True,
        "sourceName": "rating",
        "targetName": "rating",
        "type": "Double",
    }]


def legacy_job(job_id: str, target: str, *, rule_contract_version, rules) -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name=job_id.lower(),
        owner="data-team-01",
        status="scheduled",
        tag="[legacy]",
        source="SQL Result / Rule fixture",
        target=target,
        schedule="스케줄링 건너뛰기",
        source_config=[],
        source_label="Rule fixture",
        source_type="SQL Result",
        schema_columns=schema_columns(),
        schema_sample_rows=[["4.5"]],
        rule_contract_version=rule_contract_version,
        rules=rules,
        target_format="parquet",
        target_layer="SILVER",
        transform_output_columns=[["rating", "Double"]],
        transform_steps=[{
            "enabled": True,
            "id": "legacy-default",
            "input": "rating",
            "kind": "derive",
            "label": "legacy default",
            "onError": "Warn",
            "operation": "Default Value",
            "output": "rating",
            "params": "legacy",
        }],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="생성 후 미실행",
        last_state="준비됨",
        next_run="-",
        stats={},
        dag_steps=[],
    )


if __name__ == "__main__":
    main()
