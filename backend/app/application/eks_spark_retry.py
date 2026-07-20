"""Bounded same-Run SparkApplication retry state transitions."""

from __future__ import annotations

from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.services.eks_execution_contract import (
    normalize_spark_kubernetes_execution,
    spark_kubernetes_max_attempts,
    spark_kubernetes_terminal_failure,
)


def prepare_eks_spark_attempt(
    task_states: dict[str, Any],
    *,
    attempt_id: str,
    lease_generation: int,
    job_id: str,
    resource_plan: dict[str, Any] | None,
    run_id: str,
    started_at: str,
) -> tuple[dict[str, Any], dict[str, Any] | None, int]:
    """Return fenced execution state and the Kubernetes attempt to submit."""
    previous_execution = task_states.get("sparkExecution")
    previous_kubernetes_execution = (
        previous_execution.get("kubernetesExecution")
        if isinstance(previous_execution, dict)
        and isinstance(previous_execution.get("kubernetesExecution"), dict)
        else None
    )
    if previous_kubernetes_execution is not None:
        previous_kubernetes_execution = normalize_spark_kubernetes_execution(
            previous_kubernetes_execution,
            job_id=job_id,
            run_id=run_id,
        )
    previous_attempts = (
        list(previous_execution.get("kubernetesAttempts") or [])
        if isinstance(previous_execution, dict)
        and isinstance(previous_execution.get("kubernetesAttempts"), list)
        else []
    )
    terminal_replacement = spark_kubernetes_terminal_failure(
        previous_kubernetes_execution
    )
    previous_generation = int(
        (previous_kubernetes_execution or {}).get("attemptGeneration") or 1
    )
    attempt_generation = previous_generation + 1 if terminal_replacement else previous_generation
    if attempt_generation > spark_kubernetes_max_attempts():
        raise ApiError(
            "SPARK_TERMINAL_RETRY_EXHAUSTED",
            "Spark terminal retry exceeded the configured bounded attempt limit.",
            status.HTTP_409_CONFLICT,
            {
                "jobId": job_id,
                "runId": run_id,
                "attemptGeneration": previous_generation,
            },
        )
    if terminal_replacement and not any(
        isinstance(item, dict)
        and item.get("attemptGeneration") == previous_generation
        for item in previous_attempts
    ):
        previous_attempts.append(previous_kubernetes_execution)
    execution = {
        "attemptId": attempt_id,
        "generation": lease_generation,
        "startedAt": started_at,
        "status": "running",
        "kubernetesAttempts": previous_attempts,
        **({"resourcePlan": resource_plan} if resource_plan is not None else {}),
        **(
            {"kubernetesExecution": previous_kubernetes_execution}
            if previous_kubernetes_execution is not None and not terminal_replacement
            else {}
        ),
    }
    return {**task_states, "sparkExecution": execution}, previous_kubernetes_execution, attempt_generation
