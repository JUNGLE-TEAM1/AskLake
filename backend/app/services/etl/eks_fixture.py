"""EKS-only bounded Kafka fixture contract.

This module keeps the EKS fixture boundary independent from the general Kafka
Snapshot path.  It is intentionally side-effect free except for the explicit
slot lookup and Iceberg target persistence helpers used by the ETL facade.
"""

from __future__ import annotations

import os
import re
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.application.etl_job_projection import field_value, make_dataset_id, parse_positive_integer
from app.application.etl_runtime_support import is_kafka_job
from app.core.config import settings
from app.core.errors import ApiError
from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.schemas.iceberg import IcebergWriterTarget
from app.services.eks_fixture_slots import configured_eks_fixture_slot
from scripts.kafka_fixture_slots import (
    EKS_MVP_FIXTURE_CONSUMER_GROUP,
    EKS_MVP_FIXTURE_ICEBERG_TABLE,
)


EKS_MVP_FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1"
EKS_MVP_FIXTURE_BATCH_ID_FIELD = "__EKS MVP Fixture Batch ID"
EKS_MVP_FIXTURE_EXPECTED_COUNT_FIELD = "__EKS MVP Expected Count"
EKS_MVP_FIXTURE_MAX_COUNT = 100_000
EKS_MVP_FIXTURE_CONTRACT_VERSION = 2
EKS_MVP_FIXTURE_LEGACY_CONTRACT_VERSION = 1
EKS_MVP_FIXTURE_OUTPUT_PREFIX = "eks-mvp/output"
EKS_MVP_FIXTURE_CHECKPOINT_PREFIX = "eks-mvp/checkpoints"


def is_eks_mvp_bounded_fixture_job(job: ETLJobModel) -> bool:
    """Return true only for the explicit EKS Kafka fixture contract."""
    fields = getattr(job, "source_config", None) or []
    labels = {str(label) for label, _value in fields}
    topic = field_value(fields, "TOPIC / QUEUE NAME") or field_value(fields, "Topic")
    consumer_group = field_value(fields, "CONSUMER GROUP ID") or field_value(
        fields,
        "Consumer Group ID",
    )
    return (
        str(getattr(job, "execution_mode", None) or "snapshot").strip().casefold()
        == "snapshot"
        and is_kafka_job(job)
        and (
            topic == EKS_MVP_FIXTURE_TOPIC
            or consumer_group == EKS_MVP_FIXTURE_CONSUMER_GROUP
            or EKS_MVP_FIXTURE_BATCH_ID_FIELD in labels
            or EKS_MVP_FIXTURE_EXPECTED_COUNT_FIELD in labels
        )
    )


def eks_mvp_fixture_consumer_group(job: ETLJobModel) -> str:
    fields = job.source_config or []
    return str(
        field_value(fields, "CONSUMER GROUP ID")
        or field_value(fields, "Consumer Group ID")
        or ""
    ).strip()


def validate_eks_mvp_bounded_fixture_job(
    job: ETLJobModel,
    *,
    kubernetes_mode: bool,
) -> None:
    if not is_eks_mvp_bounded_fixture_job(job):
        return
    if not kubernetes_mode:
        raise ApiError(
            "EKS_MVP_FIXTURE_REQUIRES_KUBERNETES",
            "The EKS MVP bounded fixture requires ASKLAKE_SPARK_RUNNER=kubernetes.",
            status.HTTP_409_CONFLICT,
            {"jobId": job.id},
        )

    fields = job.source_config or []
    broker = (
        field_value(fields, "Broker / Endpoint")
        or field_value(fields, "Broker")
        or os.environ.get("ASKLAKE_KAFKA_BROKER")
        or ""
    ).strip()
    brokers = [item.strip() for item in broker.split(",") if item.strip()]
    if not brokers or any(re.fullmatch(r"[^,\s:]+:9098", item) is None for item in brokers):
        raise eks_mvp_fixture_contract_error(
            job,
            "Every MSK bootstrap endpoint must use IAM port 9098.",
        )

    topic = (
        field_value(fields, "TOPIC / QUEUE NAME")
        or field_value(fields, "Topic")
        or field_value(fields, "topic")
    )
    consumer_group = eks_mvp_fixture_consumer_group(job)
    fixture_batch_id = field_value(fields, EKS_MVP_FIXTURE_BATCH_ID_FIELD)
    expected_count = parse_positive_integer(
        field_value(fields, EKS_MVP_FIXTURE_EXPECTED_COUNT_FIELD),
    )
    if topic != EKS_MVP_FIXTURE_TOPIC:
        raise eks_mvp_fixture_contract_error(
            job,
            "The fixture topic is outside the EKS MVP boundary.",
        )
    if configured_eks_fixture_slot(consumer_group, job_id=job.id) is None:
        raise eks_mvp_fixture_contract_error(
            job,
            "The fixture consumer group is not an approved EKS fixture slot.",
        )
    if not fixture_batch_id:
        raise eks_mvp_fixture_contract_error(job, "The producer fixture batch id is required.")
    if expected_count is None or expected_count > EKS_MVP_FIXTURE_MAX_COUNT:
        raise eks_mvp_fixture_contract_error(
            job,
            f"The producer expected count must be between 1 and {EKS_MVP_FIXTURE_MAX_COUNT}.",
        )


def eks_mvp_fixture_contract_error(job: ETLJobModel, message: str) -> ApiError:
    return ApiError(
        "EKS_MVP_FIXTURE_CONTRACT_INVALID",
        message,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"jobId": job.id},
    )


def require_eks_mvp_fixture_slot_available(db: Session, job: ETLJobModel) -> None:
    if not is_eks_mvp_bounded_fixture_job(job):
        return
    consumer_group = eks_mvp_fixture_consumer_group(job)
    active_run = etl_repository.find_active_eks_fixture_slot_run(db, consumer_group)
    if active_run is None:
        return
    raise ApiError(
        "EKS_MVP_FIXTURE_SLOT_ACTIVE",
        "Another EKS fixture Run is already using this approved consumer group and Iceberg table slot.",
        status.HTTP_409_CONFLICT,
        {
            "activeJobId": active_run.job_id,
            "activeRunId": active_run.run_id,
            "jobId": job.id,
        },
    )


def eks_mvp_fixture_run_state(
    job: ETLJobModel,
    run_id: str,
    captured_at: str,
    *,
    kubernetes_mode: bool,
) -> dict[str, Any] | None:
    if not is_eks_mvp_bounded_fixture_job(job):
        return None
    validate_eks_mvp_bounded_fixture_job(job, kubernetes_mode=kubernetes_mode)
    fields = job.source_config or []
    broker = (
        field_value(fields, "Broker / Endpoint")
        or field_value(fields, "Broker")
        or os.environ.get("ASKLAKE_KAFKA_BROKER")
        or ""
    )
    normalized_broker = ",".join(item.strip() for item in broker.split(",") if item.strip())
    fixture_batch_id = field_value(fields, EKS_MVP_FIXTURE_BATCH_ID_FIELD)
    expected_count = parse_positive_integer(
        field_value(fields, EKS_MVP_FIXTURE_EXPECTED_COUNT_FIELD),
    )
    consumer_group = eks_mvp_fixture_consumer_group(job)
    fixture_slot = configured_eks_fixture_slot(consumer_group, job_id=job.id)
    if fixture_slot is None:
        raise eks_mvp_fixture_contract_error(
            job,
            "The fixture consumer group is not an approved EKS fixture slot.",
        )
    output_bucket = str(
        os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output",
    ).strip()
    if re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", output_bucket) is None:
        raise eks_mvp_fixture_contract_error(
            job,
            "ASKLAKE_SPARK_OUTPUT_BUCKET is not a valid S3 bucket name.",
        )
    source_boundary = {
        "broker": normalized_broker,
        "checkpointPath": (
            f"s3a://{output_bucket}/{EKS_MVP_FIXTURE_CHECKPOINT_PREFIX}/{run_id}"
        ),
        "consumerGroup": consumer_group,
        "expectedCount": expected_count,
        "fixtureBatchId": fixture_batch_id,
        "kind": "kafka_snapshot",
        "outputPath": f"s3a://{output_bucket}/{EKS_MVP_FIXTURE_OUTPUT_PREFIX}/{run_id}",
        "snapshotId": run_id,
        "topic": EKS_MVP_FIXTURE_TOPIC,
    }
    return {
        "capturedAt": captured_at,
        "contractVersion": EKS_MVP_FIXTURE_CONTRACT_VERSION,
        "icebergTable": fixture_slot.iceberg_table,
        "runId": run_id,
        "sourceBoundary": source_boundary,
    }


def persisted_eks_mvp_fixture_source_boundary(
    run: ETLRunModel,
) -> dict[str, Any] | None:
    state = (run.task_states or {}).get("eksMvpFixture")
    if state is None:
        return None
    boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
    broker = str(boundary.get("broker") or "") if isinstance(boundary, dict) else ""
    brokers = [item.strip() for item in broker.split(",") if item.strip()]
    expected_count = boundary.get("expectedCount") if isinstance(boundary, dict) else None
    consumer_group = (
        str(boundary.get("consumerGroup") or "") if isinstance(boundary, dict) else ""
    )
    configured_slot = configured_eks_fixture_slot(consumer_group)
    contract_version = state.get("contractVersion") if isinstance(state, dict) else None
    output_path = (
        str(boundary.get("outputPath") or "") if isinstance(boundary, dict) else ""
    )
    checkpoint_path = (
        str(boundary.get("checkpointPath") or "") if isinstance(boundary, dict) else ""
    )
    if (
        not isinstance(state, dict)
        or contract_version
        not in (
            EKS_MVP_FIXTURE_LEGACY_CONTRACT_VERSION,
            EKS_MVP_FIXTURE_CONTRACT_VERSION,
        )
        or state.get("runId") != run.run_id
        or not str(state.get("capturedAt") or "").strip()
        or not isinstance(boundary, dict)
        or boundary.get("kind") != "kafka_snapshot"
        or boundary.get("snapshotId") != run.run_id
        or boundary.get("topic") != EKS_MVP_FIXTURE_TOPIC
        or configured_slot is None
        or (
            contract_version == EKS_MVP_FIXTURE_LEGACY_CONTRACT_VERSION
            and (
                consumer_group != EKS_MVP_FIXTURE_CONSUMER_GROUP
                or configured_slot.iceberg_table != EKS_MVP_FIXTURE_ICEBERG_TABLE
            )
        )
        or (
            contract_version == EKS_MVP_FIXTURE_CONTRACT_VERSION
            and state.get("icebergTable") != configured_slot.iceberg_table
        )
        or not str(boundary.get("fixtureBatchId") or "").strip()
        or isinstance(expected_count, bool)
        or not isinstance(expected_count, int)
        or expected_count < 1
        or expected_count > EKS_MVP_FIXTURE_MAX_COUNT
        or not brokers
        or any(re.fullmatch(r"[^,\s:]+:9098", item) is None for item in brokers)
        or re.fullmatch(
            rf"s3a://[^/]+/{re.escape(EKS_MVP_FIXTURE_OUTPUT_PREFIX)}/{re.escape(run.run_id)}",
            output_path,
        )
        is None
        or re.fullmatch(
            rf"s3a://[^/]+/{re.escape(EKS_MVP_FIXTURE_CHECKPOINT_PREFIX)}/{re.escape(run.run_id)}",
            checkpoint_path,
        )
        is None
    ):
        raise ApiError(
            "EKS_MVP_FIXTURE_RUN_BOUNDARY_INVALID",
            "The persisted EKS fixture boundary does not match its AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": run.job_id, "runId": run.run_id},
        )
    return dict(boundary)


def require_matching_airflow_source_boundary(
    run: ETLRunModel,
    airflow_source_boundary: dict[str, Any] | None,
) -> dict[str, Any] | None:
    persisted = persisted_eks_mvp_fixture_source_boundary(run)
    if persisted is None and airflow_source_boundary is None:
        return None
    if (
        persisted is None
        or not isinstance(airflow_source_boundary, dict)
        or airflow_source_boundary != persisted
    ):
        raise ApiError(
            "AIRFLOW_SOURCE_BOUNDARY_MISMATCH",
            "Airflow source boundary does not match the persisted AskLake Run boundary.",
            status.HTTP_409_CONFLICT,
            {"jobId": run.job_id, "runId": run.run_id},
        )
    return persisted


def run_uses_eks_execution(run: ETLRunModel | None) -> bool:
    if run is None:
        return False
    task_states = run.task_states or {}
    spark_result = task_states.get("sparkResult")
    return isinstance(task_states.get("eksMvpFixture"), dict) or (
        isinstance(spark_result, dict)
        and isinstance(spark_result.get("kubernetesExecution"), dict)
    )


def eks_mvp_fixture_iceberg_target(job: ETLJobModel) -> IcebergWriterTarget:
    consumer_group = eks_mvp_fixture_consumer_group(job)
    slot = configured_eks_fixture_slot(consumer_group, job_id=job.id)
    if slot is None:
        raise eks_mvp_fixture_contract_error(
            job,
            "The fixture consumer group is not an approved EKS fixture slot.",
        )
    return IcebergWriterTarget(
        catalog=settings.trino_catalog,
        namespace=settings.trino_schema,
        table=slot.iceberg_table,
        write_mode="replace",
        partition_columns=[],
    )


def ensure_eks_mvp_fixture_iceberg_target(
    db: Session,
    job: ETLJobModel,
) -> bool:
    """Persist the approved EKS target and report whether the job was a fixture."""
    if not is_eks_mvp_bounded_fixture_job(job):
        return False
    expected_target = eks_mvp_fixture_iceberg_target(job)
    if job.iceberg_target:
        try:
            if IcebergWriterTarget.model_validate(job.iceberg_target) == expected_target:
                return True
        except Exception:
            pass
    job.dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    job.iceberg_target = expected_target.model_dump(mode="json", by_alias=True)
    db.add(job)
    db.commit()
    return True


def validate_eks_mvp_fixture_spark_result(
    job: ETLJobModel,
    run_id: str,
    source_boundary: dict[str, Any] | None,
    manifest: dict[str, Any],
) -> None:
    if source_boundary is None or manifest.get("status") != "success":
        return

    expected_count = source_boundary["expectedCount"]
    expected_target = eks_mvp_fixture_iceberg_target(job)
    commit = manifest.get("icebergCommit")
    try:
        persisted_target = IcebergWriterTarget.model_validate(job.iceberg_target)
        committed_target = IcebergWriterTarget.model_validate(
            commit.get("target") if isinstance(commit, dict) else None,
        )
    except Exception as exc:
        raise ApiError(
            "EKS_MVP_FIXTURE_RESULT_INVALID",
            "Successful EKS fixture Spark result does not contain a valid Iceberg target.",
            status.HTTP_502_BAD_GATEWAY,
            {"jobId": job.id, "runId": run_id},
        ) from exc

    mismatches: list[str] = []
    if manifest.get("sourceBoundary") != source_boundary:
        mismatches.append("sourceBoundary")
    if manifest.get("inputRows") != expected_count:
        mismatches.append("inputRows")
    if manifest.get("outputRows") != expected_count:
        mismatches.append("outputRows")
    if persisted_target != expected_target:
        mismatches.append("persistedIcebergTarget")
    if committed_target != expected_target:
        mismatches.append("committedIcebergTarget")
    if str(manifest.get("outputPath") or "") != expected_target.table_uri:
        mismatches.append("outputPath")
    if not isinstance(commit, dict) or commit.get("sourceBoundary") != source_boundary:
        mismatches.append("commitSourceBoundary")
    if not isinstance(commit, dict) or str(commit.get("jobId") or "") != job.id:
        mismatches.append("commitJobId")
    if not isinstance(commit, dict) or str(commit.get("runId") or "") != run_id:
        mismatches.append("commitRunId")
    if not isinstance(commit, dict) or not str(commit.get("snapshotId") or "").strip():
        mismatches.append("snapshotId")
    if mismatches:
        raise ApiError(
            "EKS_MVP_FIXTURE_RESULT_INVALID",
            "Spark result does not prove the persisted EKS fixture boundary was committed with the expected identity.",
            status.HTTP_502_BAD_GATEWAY,
            {
                "expectedCount": expected_count,
                "jobId": job.id,
                "mismatches": mismatches,
                "runId": run_id,
                "target": expected_target.table_uri,
            },
        )
