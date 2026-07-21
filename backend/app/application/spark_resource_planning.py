"""Initial Spark executor planning from immutable source-size evidence."""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

from app.application.etl_source_window import build_source_s3_client, s3_object_size
from app.application.eks_spark_retry import prepare_eks_spark_attempt
from app.core.config import settings
from app.core.s3_policy import (
    resolve_s3_source_location,
    s3_source_config_fields,
    validate_s3_source_config,
)
from app.domain.spark_resource_plan import (
    SUPPORTED_EXECUTOR_TIERS,
    build_spark_resource_plan,
    normalize_spark_resource_plan,
    spark_resource_planner_mode,
)
from app.domain.spark_resource_history import normalize_spark_resource_history
from app.models import ETLJobModel
from app.services.eks_execution_contract import spark_execution_identity_mismatch


def prepare_eks_spark_attempt_with_resource_plan(
    task_states: dict[str, Any],
    *,
    attempt_id: str,
    job: ETLJobModel,
    job_id: str,
    lease_generation: int,
    run_id: str,
    started_at: str,
    historical_runs: Iterable[Any] = (),
) -> tuple[dict[str, Any], dict[str, Any] | None, int, dict[str, Any] | None]:
    previous_execution = task_states.get("sparkExecution")
    resource_plan = resolve_spark_resource_plan_for_execution(
        previous_execution,
        job,
        job_id=job_id,
        run_id=run_id,
        historical_runs=historical_runs,
    )
    prepared, previous_kubernetes, generation = prepare_eks_spark_attempt(
        task_states,
        attempt_id=attempt_id,
        lease_generation=lease_generation,
        job_id=job_id,
        resource_plan=resource_plan,
        run_id=run_id,
        started_at=started_at,
    )
    return prepared, previous_kubernetes, generation, resource_plan


def resolve_spark_resource_plan_for_execution(
    previous_execution: Any,
    job: ETLJobModel,
    *,
    job_id: str,
    run_id: str,
    historical_runs: Iterable[Any] = (),
) -> dict[str, Any] | None:
    previous_resource_plan = (
        previous_execution.get("resourcePlan")
        if isinstance(previous_execution, dict)
        else None
    )
    if previous_resource_plan is not None:
        try:
            return normalize_spark_resource_plan(previous_resource_plan)
        except ValueError as exc:
            raise spark_execution_identity_mismatch(
                f"Persisted Spark Resource Plan is invalid: {exc}",
                job_id=job_id,
                run_id=run_id,
            ) from exc
    if (
        isinstance(previous_execution, dict)
        and isinstance(previous_execution.get("kubernetesExecution"), dict)
    ):
        # Runs first submitted before the planner rollout retain their existing
        # SparkApplication identity instead of introducing a plan during retry.
        return None
    return spark_resource_plan_for_job(
        job,
        current_run_id=run_id,
        historical_runs=historical_runs,
    )


def spark_resource_plan_for_job(
    job: ETLJobModel,
    *,
    current_run_id: str = "",
    historical_runs: Iterable[Any] = (),
    s3_client: Any | None = None,
) -> dict[str, Any] | None:
    if spark_resource_planner_mode() == "off":
        return None
    estimate = spark_resource_input_estimate(job, s3_client=s3_client)
    try:
        baseline_executors = int(
            str(os.environ.get("ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES") or "1").strip()
        )
    except ValueError:
        baseline_executors = 1
    historical_observations = normalize_spark_resource_history(
        historical_runs,
        current_run_id=current_run_id,
        supported_executors=SUPPORTED_EXECUTOR_TIERS,
        normalize_plan=normalize_spark_resource_plan,
    )
    return build_spark_resource_plan(
        input_bytes=estimate.get("inputBytes"),
        input_file_count=estimate.get("inputFileCount"),
        input_size_source=str(estimate.get("inputSizeSource") or ""),
        baseline_executors=max(1, baseline_executors),
        historical_observations=historical_observations,
    )


def spark_resource_input_estimate(
    job: ETLJobModel,
    *,
    s3_client: Any | None = None,
) -> dict[str, Any]:
    source_type = str(getattr(job, "source_type", "") or "").strip().casefold()
    if not source_type.startswith("file / s3"):
        return _unavailable_estimate()
    fields = s3_source_config_fields(getattr(job, "source_config", None) or [])
    selection_kind = fields.get("__selection kind", "file").strip().casefold()
    if selection_kind == "prefix":
        try:
            total_bytes = s3_object_size(fields.get("__source total bytes"))
            file_count = int(fields.get("__source unit count") or "0")
        except Exception:
            return _unavailable_estimate()
        return {
            "inputBytes": total_bytes,
            "inputFileCount": max(0, file_count),
            "inputSizeSource": "source_selection_snapshot",
        }

    try:
        validate_s3_source_config(
            job.source_type,
            job.source_config or [],
            allow_unconfigured=_allows_unconfigured_s3_source(),
        )
        bucket, configured_key = resolve_s3_source_location(job.source_type, fields)
        selected_key = (
            fields.get("__selected object")
            or fields.get("__sample object")
            or configured_key
        ).strip()
        parsed_selected = urlparse(selected_key)
        if parsed_selected.scheme.casefold() in {"s3", "s3a"}:
            if parsed_selected.netloc and bucket and parsed_selected.netloc != bucket:
                return _unavailable_estimate()
            bucket = parsed_selected.netloc or bucket
            selected_key = parsed_selected.path.lstrip("/")
        selected_key = selected_key.lstrip("/")
        if bucket and selected_key.startswith(f"{bucket}/"):
            selected_key = selected_key[len(bucket) + 1:]
        if not bucket or not selected_key:
            raise ValueError("S3 object identity is incomplete")
        response = (s3_client or build_source_s3_client(job)).head_object(
            Bucket=bucket,
            Key=selected_key,
        )
        return {
            "inputBytes": s3_object_size(response.get("ContentLength")),
            "inputFileCount": 1,
            "inputSizeSource": "s3_head",
        }
    except Exception:
        # Planning metadata must not fail the data run. Existing source identity
        # validation remains authoritative and executes independently.
        return _unavailable_estimate()


def _allows_unconfigured_s3_source() -> bool:
    return str(getattr(settings, "app_env", "local") or "local").strip().casefold() in {
        "dev",
        "development",
        "local",
        "test",
    }


def _unavailable_estimate() -> dict[str, Any]:
    return {
        "inputBytes": None,
        "inputFileCount": None,
        "inputSizeSource": "unavailable",
    }
