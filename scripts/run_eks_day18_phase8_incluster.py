"""Day 18 Phase 8 in-cluster control and read-only verification helper."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text

from app.application.eks_msk_fault_execution import (
    record_eks_msk_authorization_fault,
)
from app.application.etl_job_projection import stats_from_runs
from app.application.etl_run_projection import (
    apply_airflow_result_to_reserved_run,
    apply_airflow_submit_job_state,
    dag_steps_from_airflow_submit,
    mark_airflow_submission_unknown,
)
from app.core.database import SessionLocal
from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.services import etl_service
from app.services.airflow_client import build_airflow_client
from app.services.etl.eks_fixture import (
    persisted_eks_mvp_fixture_source_boundary,
)
from app.services.iceberg_writer_service import IcebergWriterService
from scripts.run_eks_day17_multi_spark import (
    ACTIVE_RUN_STATUSES,
    candidate_fact,
    collect_preflight,
)
from scripts.verify_eks_day17_multi_spark_results import collect_run_record


FAULT_ALIASES = {"Run D": "Run A", "Run E": "Run B"}
CAMPAIGN_PATTERN = re.compile(r"^[a-f0-9]{32}$")
EXPECTED_COUNT = 100


class Day18Phase8Error(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def short_hash(value: object) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:12]


def require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise Day18Phase8Error(f"{label} must be an object")
    return value


def require_text(value: Any, label: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise Day18Phase8Error(f"{label} is required")
    return normalized


def request_campaign(request: dict[str, Any]) -> str:
    campaign_id = require_text(request.get("campaignId"), "campaignId")
    if CAMPAIGN_PATTERN.fullmatch(campaign_id) is None:
        raise Day18Phase8Error("campaignId is invalid")
    return campaign_id


def request_alias(request: dict[str, Any]) -> tuple[str, str]:
    alias = require_text(request.get("alias"), "alias")
    source_alias = FAULT_ALIASES.get(alias)
    if source_alias is None:
        raise Day18Phase8Error("fault alias is invalid")
    return alias, source_alias


def validate_target(
    db: Any,
    request: dict[str, Any],
) -> tuple[ETLJobModel, dict[str, Any], str, str]:
    alias, source_alias = request_alias(request)
    target = require_mapping(request.get("target"), "target")
    if target.get("alias") != alias or target.get("sourceAlias") != source_alias:
        raise Day18Phase8Error("fault target aliases do not match")
    job_id = require_text(target.get("jobId"), "target.jobId")
    job = db.get(ETLJobModel, job_id)
    fact = candidate_fact(job) if job is not None else None
    if fact is None or fact.alias != source_alias:
        raise Day18Phase8Error("fault target is not an approved isolated candidate")
    expected = {
        "datasetId": fact.dataset_id,
        "fixtureBatchId": fact.batch_id,
        "consumerGroup": fact.consumer_group,
        "icebergTable": fact.target_table,
        "expectedCount": fact.expected_count,
    }
    for key, value in expected.items():
        if target.get(key) != value:
            raise Day18Phase8Error(f"fault target {key} does not match")
    if fact.expected_count != EXPECTED_COUNT:
        raise Day18Phase8Error("fault target expected count is invalid")
    return job, target, alias, source_alias


def campaign_marker(run: ETLRunModel) -> dict[str, Any] | None:
    marker = (run.task_states or {}).get("day18Phase8")
    return marker if isinstance(marker, dict) else None


def campaign_runs(
    db: Any,
    *,
    campaign_id: str,
    alias: str,
    job_id: str,
) -> list[ETLRunModel]:
    runs = db.scalars(
        select(ETLRunModel).where(ETLRunModel.job_id == job_id)
    ).all()
    return [
        run
        for run in runs
        if (marker := campaign_marker(run)) is not None
        and marker.get("campaignId") == campaign_id
        and marker.get("alias") == alias
    ]


def update_marker(
    run: ETLRunModel,
    *,
    campaign_id: str,
    alias: str,
    source_alias: str,
    state: str,
) -> None:
    previous = campaign_marker(run) or {}
    run.task_states = {
        **(run.task_states or {}),
        "day18Phase8": {
            **previous,
            "campaignId": campaign_id,
            "alias": alias,
            "sourceAlias": source_alias,
            "state": state,
            "updatedAt": utc_now(),
            **(
                {"createdAt": previous.get("createdAt") or utc_now()}
                if "createdAt" not in previous
                else {}
            ),
        },
    }


def private_identity(
    job: ETLJobModel,
    run: ETLRunModel,
    *,
    alias: str,
    source_alias: str,
) -> dict[str, Any]:
    fixture = (run.task_states or {}).get("eksMvpFixture")
    boundary = (
        fixture.get("sourceBoundary")
        if isinstance(fixture, dict)
        and isinstance(fixture.get("sourceBoundary"), dict)
        else None
    )
    if not isinstance(boundary, dict):
        raise Day18Phase8Error("persisted fixture boundary is missing")
    identity = {
        "alias": alias,
        "sourceAlias": source_alias,
        "jobId": job.id,
        "runId": run.run_id,
        "datasetId": str(job.dataset_id or ""),
        "consumerGroup": str(boundary.get("consumerGroup") or ""),
        "icebergTable": str(fixture.get("icebergTable") or ""),
        "outputPath": str(boundary.get("outputPath") or ""),
        "checkpointPath": str(boundary.get("checkpointPath") or ""),
        "fixtureBatchId": str(boundary.get("fixtureBatchId") or ""),
        "expectedCount": int(boundary.get("expectedCount") or 0),
    }
    if any(
        not str(identity.get(key) or "").strip()
        for key in (
            "jobId",
            "runId",
            "datasetId",
            "consumerGroup",
            "icebergTable",
            "outputPath",
            "checkpointPath",
            "fixtureBatchId",
        )
    ) or identity["expectedCount"] != EXPECTED_COUNT:
        raise Day18Phase8Error("persisted fault Run identity is incomplete")
    return identity


def initialize_mutation_schema() -> None:
    """Finish repository DDL before opening a fault-run transaction.

    The helper runs in a fresh Python process for every action, so the
    repository's process-local schema cache starts empty. Letting
    save_command_result initialize the schema after the action has already
    read etl_jobs creates a self-blocking PostgreSQL lock: that transaction
    holds an ACCESS SHARE lock while a second connection requests ALTER TABLE.
    """
    db = SessionLocal()
    try:
        etl_repository.ensure_schema(db)
    finally:
        db.close()


def reserve_fault_run(request: dict[str, Any]) -> dict[str, Any]:
    campaign_id = request_campaign(request)
    db = SessionLocal()
    try:
        job, _, alias, source_alias = validate_target(db, request)
        existing = campaign_runs(
            db,
            campaign_id=campaign_id,
            alias=alias,
            job_id=job.id,
        )
        if len(existing) > 1:
            raise Day18Phase8Error("multiple fault Runs exist for one campaign alias")
        if existing:
            run = existing[0]
            return {
                "status": "reconciled",
                "identity": private_identity(
                    job,
                    run,
                    alias=alias,
                    source_alias=source_alias,
                ),
            }

        preflight, _ = collect_preflight()
        if preflight.get("status") != "passed":
            raise Day18Phase8Error("isolated fixture preflight is blocked")
        active_for_job = int(
            db.scalar(
                select(ETLRunModel)
                .where(
                    ETLRunModel.job_id == job.id,
                    ETLRunModel.status.in_(ACTIVE_RUN_STATUSES),
                )
                .with_only_columns(ETLRunModel.run_id)
                .limit(1)
            )
            is not None
        )
        if active_for_job:
            raise Day18Phase8Error("fault target already has an active Run")

        airflow_client = build_airflow_client()
        # These operations are runtime-bound by the public ETL facade. Importing
        # their extracted implementation module directly bypasses that binding
        # and leaves dependencies such as spark_kubernetes_mode_enabled absent.
        run = etl_service.airflow_run_reservation(job, "run", airflow_client)
        update_marker(
            run,
            campaign_id=campaign_id,
            alias=alias,
            source_alias=source_alias,
            state="reserved",
        )
        run_schema = etl_repository.run_to_schema(run)
        apply_airflow_submit_job_state(job, "run", run)
        job.dag_steps = dag_steps_from_airflow_submit(
            job,
            "run",
            run_schema.model_dump(by_alias=True),
        )
        job.dag_steps_by_run_id = {
            **(job.dag_steps_by_run_id or {}),
            run.run_id: job.dag_steps,
        }
        job.stats = stats_from_runs(
            job,
            [
                run_schema,
                *etl_repository.list_runs_for_job(db, job.id),
            ],
        )
        etl_repository.save_command_result(db, job, run)
        return {
            "status": "reserved",
            "identity": private_identity(
                job,
                run,
                alias=alias,
                source_alias=source_alias,
            ),
        }
    finally:
        db.close()


def require_campaign_run(
    db: Any,
    request: dict[str, Any],
) -> tuple[ETLJobModel, ETLRunModel, dict[str, Any], str, str, str]:
    campaign_id = request_campaign(request)
    job, target, alias, source_alias = validate_target(db, request)
    run_id = require_text(
        require_mapping(request.get("identity"), "identity").get("runId"),
        "identity.runId",
    )
    run = db.get(ETLRunModel, run_id)
    marker = campaign_marker(run) if run is not None else None
    if (
        run is None
        or run.job_id != job.id
        or marker is None
        or marker.get("campaignId") != campaign_id
        or marker.get("alias") != alias
        or marker.get("sourceAlias") != source_alias
    ):
        raise Day18Phase8Error("persisted fault Run does not match the campaign")
    expected_identity = private_identity(
        job,
        run,
        alias=alias,
        source_alias=source_alias,
    )
    supplied_identity = require_mapping(request.get("identity"), "identity")
    for key, expected in expected_identity.items():
        if supplied_identity.get(key) != expected:
            raise Day18Phase8Error(f"private identity {key} does not match")
    return job, run, target, alias, source_alias, campaign_id


def record_msk_fault(request: dict[str, Any]) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job, run, _, alias, source_alias, campaign_id = require_campaign_run(
            db,
            request,
        )
        evidence_sha256 = require_text(
            request.get("evidenceSha256"),
            "evidenceSha256",
        )
        attempt = record_eks_msk_authorization_fault(
            db,
            acknowledged_records=0,
            attempted_records=1,
            category="AUTHORIZATION",
            evidence_sha256=evidence_sha256,
            job_id=job.id,
            run_id=run.run_id,
        )
        run = db.get(ETLRunModel, run.run_id)
        if run is None:
            raise Day18Phase8Error("fault Run disappeared after MSK evidence")
        update_marker(
            run,
            campaign_id=campaign_id,
            alias=alias,
            source_alias=source_alias,
            state="msk_fault_recorded",
        )
        db.commit()
        return {
            "status": "recorded",
            "generation": int(attempt.get("generation") or 0),
        }
    finally:
        db.close()


def execute_reserved_spark(request: dict[str, Any]) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job, run, _, alias, source_alias, campaign_id = require_campaign_run(
            db,
            request,
        )
        if alias != "Run E":
            raise Day18Phase8Error("direct Spark fault execution is allowed only for Run E")
        boundary = persisted_eks_mvp_fixture_source_boundary(run)
        result = etl_service.execute_airflow_spark_run(
            db,
            job_id=job.id,
            run_id=run.run_id,
            command="run",
            airflow_source_boundary=boundary,
        )
        db.expire_all()
        run = db.get(ETLRunModel, run.run_id)
        if run is not None:
            update_marker(
                run,
                campaign_id=campaign_id,
                alias=alias,
                source_alias=source_alias,
                state="first_spark_attempt_terminal",
            )
            db.commit()
        return {
            "status": str(result.get("status") or "unknown"),
            "attemptGeneration": int(
                ((result.get("kubernetesExecution") or {}).get("attemptGeneration"))
                or 0
            ),
        }
    finally:
        db.close()


def submit_reserved_run(request: dict[str, Any]) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job, run, _, alias, source_alias, campaign_id = require_campaign_run(
            db,
            request,
        )
        airflow_client = build_airflow_client()
        submitted, error = etl_service.submit_or_reconcile_airflow_job_run(
            job,
            "run",
            run,
            airflow_client,
        )
        job = etl_repository.get_job_for_update(db, job.id)
        reserved = etl_repository.get_run_model(db, run.run_id)
        if job is None or reserved is None or reserved.job_id != job.id:
            raise Day18Phase8Error("fault Run disappeared during Airflow submission")
        etl_repository.refresh_run_for_update(db, reserved)
        if submitted is not None:
            apply_airflow_result_to_reserved_run(reserved, submitted)
        else:
            mark_airflow_submission_unknown(reserved, error)
        update_marker(
            reserved,
            campaign_id=campaign_id,
            alias=alias,
            source_alias=source_alias,
            state="airflow_submitted" if submitted is not None else "airflow_unknown",
        )
        run_schema = etl_repository.run_to_schema(reserved)
        apply_airflow_submit_job_state(job, "run", reserved)
        job.dag_steps = dag_steps_from_airflow_submit(
            job,
            "run",
            run_schema.model_dump(by_alias=True),
        )
        job.dag_steps_by_run_id = {
            **(job.dag_steps_by_run_id or {}),
            reserved.run_id: job.dag_steps,
        }
        job.stats = stats_from_runs(
            job,
            [
                run_schema,
                *[
                    previous
                    for previous in etl_repository.list_runs_for_job(db, job.id)
                    if previous.run_id != reserved.run_id
                ],
            ],
        )
        etl_repository.save_command_result(db, job, reserved)
        if submitted is None:
            raise Day18Phase8Error("Airflow submission outcome is unknown")
        return {"status": "submitted"}
    finally:
        db.close()


def inspect_fault_run(request: dict[str, Any]) -> dict[str, Any]:
    db = SessionLocal()
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        job, run, _, alias, source_alias, _ = require_campaign_run(db, request)
        marker = campaign_marker(run) or {}
        states = run.task_states if isinstance(run.task_states, dict) else {}
        execution = (
            states.get("sparkExecution")
            if isinstance(states.get("sparkExecution"), dict)
            else {}
        )
        current = (
            execution.get("kubernetesExecution")
            if isinstance(execution.get("kubernetesExecution"), dict)
            else {}
        )
        attempts = (
            execution.get("kubernetesAttempts")
            if isinstance(execution.get("kubernetesAttempts"), list)
            else []
        )
        spark_result = (
            states.get("sparkResult")
            if isinstance(states.get("sparkResult"), dict)
            else {}
        )
        catalog_result = (
            states.get("catalogResult")
            if isinstance(states.get("catalogResult"), dict)
            else {}
        )
        fault_attempts = [
            item
            for item in (states.get("faultAttempts") or [])
            if isinstance(item, dict)
        ]
        return {
            "status": "observed",
            "alias": alias,
            "campaignState": str(marker.get("state") or ""),
            "runStatus": str(run.status or ""),
            "airflowState": str(run.airflow_state or ""),
            "owner": str(run.execution_owner or ""),
            "executionGeneration": int(run.execution_generation or 0),
            "faultAttemptCount": len(fault_attempts),
            "sparkExecutionStatus": str(execution.get("status") or ""),
            "sparkResultStatus": str(spark_result.get("status") or ""),
            "catalogStatus": str(catalog_result.get("status") or ""),
            "currentApplication": {
                "name": str(current.get("applicationName") or ""),
                "uid": str(current.get("applicationUid") or ""),
                "driverPodName": str(current.get("driverPodName") or ""),
                "state": str(current.get("state") or ""),
                "attemptGeneration": int(current.get("attemptGeneration") or 0),
            },
            "attempts": [
                {
                    "name": str(item.get("applicationName") or ""),
                    "uid": str(item.get("applicationUid") or ""),
                    "state": str(item.get("state") or ""),
                    "attemptGeneration": int(item.get("attemptGeneration") or 0),
                }
                for item in attempts
                if isinstance(item, dict)
            ],
            "identity": private_identity(
                job,
                run,
                alias=alias,
                source_alias=source_alias,
            ),
        }
    finally:
        db.close()


def verify_fault_run(request: dict[str, Any]) -> dict[str, Any]:
    db = SessionLocal()
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        job, run, _, alias, _, _ = require_campaign_run(db, request)
        record = collect_run_record(
            db,
            IcebergWriterService(),
            require_mapping(request.get("identity"), "identity"),
        )
        states = run.task_states if isinstance(run.task_states, dict) else {}
        execution = (
            states.get("sparkExecution")
            if isinstance(states.get("sparkExecution"), dict)
            else {}
        )
        current = (
            execution.get("kubernetesExecution")
            if isinstance(execution.get("kubernetesExecution"), dict)
            else {}
        )
        attempts = [
            item
            for item in (execution.get("kubernetesAttempts") or [])
            if isinstance(item, dict)
        ]
        fault_attempts = [
            item
            for item in (states.get("faultAttempts") or [])
            if isinstance(item, dict)
        ]
        base_checks = record.get("checks") if isinstance(record.get("checks"), dict) else {}
        checks = {
            **base_checks,
            "rdsOwnerReleased": not run.execution_owner,
            "airflowSameRun": run.airflow_dag_run_id == run.run_id,
            "terminalGenerationRecorded": int(run.execution_generation or 0) >= 2,
        }
        if alias == "Run D":
            checks.update(
                {
                    "authorizationFaultExactlyOnce": len(fault_attempts) == 1
                    and fault_attempts[0].get("kind") == "msk_authorization"
                    and fault_attempts[0].get("category") == "AUTHORIZATION"
                    and fault_attempts[0].get("attemptedRecords") == 1
                    and fault_attempts[0].get("acknowledgedRecords") == 0,
                    "singleSparkAttempt": len(attempts) == 0
                    and current.get("attemptGeneration") == 1,
                }
            )
        else:
            previous = attempts[0] if len(attempts) == 1 else {}
            previous_uid = str(previous.get("applicationUid") or "")
            current_uid = str(current.get("applicationUid") or "")
            checks.update(
                {
                    "oneTerminalFailedAttempt": len(attempts) == 1
                    and str(previous.get("state") or "").upper()
                    in {"FAILED", "SUBMISSION_FAILED"},
                    "boundedSecondAttempt": current.get("attemptGeneration") == 2,
                    "applicationUidsUnique": bool(previous_uid)
                    and bool(current_uid)
                    and previous_uid != current_uid,
                }
            )
        return {
            "contractVersion": "1.0",
            "mode": "read-only",
            "alias": alias,
            "status": "passed" if checks and all(checks.values()) else "failed",
            "generation": int(run.execution_generation or 0),
            "checks": checks,
            "counts": record.get("counts") or {},
            "identityHashes": {
                "run": short_hash(run.run_id),
                "job": short_hash(job.id),
                "application": short_hash(current.get("applicationUid")),
            },
        }
    finally:
        db.close()


def inspect_bounded_runs(request: dict[str, Any]) -> dict[str, Any]:
    identities = request.get("identities")
    if not isinstance(identities, list) or len(identities) != 3:
        raise Day18Phase8Error("bounded identities must contain exactly three Runs")
    expected_aliases = ("Run A", "Run B", "Run C")
    db = SessionLocal()
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        runs = []
        for expected_alias, identity in zip(
            expected_aliases,
            identities,
            strict=True,
        ):
            identity = require_mapping(identity, "bounded identity")
            if identity.get("alias") != expected_alias:
                raise Day18Phase8Error("bounded Run aliases are invalid")
            job_id = require_text(identity.get("jobId"), "bounded jobId")
            run_id = require_text(identity.get("runId"), "bounded runId")
            job = db.get(ETLJobModel, job_id)
            run = db.get(ETLRunModel, run_id)
            fact = candidate_fact(job) if job is not None else None
            if (
                job is None
                or run is None
                or run.job_id != job.id
                or fact is None
                or fact.alias != expected_alias
                or identity.get("datasetId") != fact.dataset_id
            ):
                raise Day18Phase8Error("bounded persisted identity does not match")
            states = run.task_states if isinstance(run.task_states, dict) else {}
            spark = (
                states.get("sparkResult")
                if isinstance(states.get("sparkResult"), dict)
                else {}
            )
            catalog = (
                states.get("catalogResult")
                if isinstance(states.get("catalogResult"), dict)
                else {}
            )
            runs.append(
                {
                    "alias": expected_alias,
                    "status": str(run.status or ""),
                    "airflowState": str(run.airflow_state or ""),
                    "sparkStatus": str(spark.get("status") or ""),
                    "catalogStatus": str(catalog.get("status") or ""),
                    "generation": int(run.execution_generation or 0),
                }
            )
        return {
            "status": (
                "passed"
                if all(
                    item["status"] == "success"
                    and item["airflowState"] == "success"
                    and item["sparkStatus"] == "success"
                    and item["catalogStatus"] == "success"
                    for item in runs
                )
                else "waiting"
            ),
            "runs": runs,
        }
    finally:
        db.close()


def preflight(request: dict[str, Any]) -> dict[str, Any]:
    bounded = request.get("boundedTargets")
    if not isinstance(bounded, list) or len(bounded) != 3:
        raise Day18Phase8Error("boundedTargets must contain exactly three targets")
    preflight_result, facts = collect_preflight()
    by_alias = {fact.alias: fact for fact in facts}
    target_match = True
    for target in bounded:
        if not isinstance(target, dict):
            target_match = False
            continue
        alias = str(target.get("alias") or "")
        fact = by_alias.get(alias)
        target_match = target_match and fact is not None and all(
            (
                target.get("jobId") == fact.job_id,
                target.get("datasetId") == fact.dataset_id,
                target.get("fixtureBatchId") == fact.batch_id,
                target.get("consumerGroup") == fact.consumer_group,
                target.get("icebergTable") == fact.target_table,
                target.get("expectedCount") == fact.expected_count,
            )
        )
    checks = {
        "day17PreflightPassed": preflight_result.get("status") == "passed",
        "approvedTargetsExact": target_match,
        "activeFixtureRunsZero": int(
            (preflight_result.get("counts") or {}).get("activeFixtureRuns") or 0
        )
        == 0,
        # Day 17 reports durable control-plane rows, not active EKS processes.
        # Existing runtime/session history is expected while EC2 remains the
        # owner. The outer runner verifies the live process boundary and the
        # cleanup path proves these durable row counts remain unchanged.
        "continuousRowsReadable": all(
            isinstance((preflight_result.get("counts") or {}).get(key), int)
            and (preflight_result.get("counts") or {}).get(key) >= 0
            for key in ("continuousRuntimes", "continuousSessions")
        ),
        "sparkApplicationsReadable": bool(
            (preflight_result.get("checks") or {}).get(
                "sparkApplicationListReadable"
            )
        ),
    }
    return {
        "contractVersion": "1.0",
        "status": "passed" if all(checks.values()) else "blocked",
        "checks": checks,
        "counts": preflight_result.get("counts") or {},
    }


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = require_text(request.get("action"), "action")
    actions = {
        "preflight": preflight,
        "reserve": reserve_fault_run,
        "record_msk_fault": record_msk_fault,
        "execute": execute_reserved_spark,
        "submit": submit_reserved_run,
        "inspect": inspect_fault_run,
        "verify": verify_fault_run,
        "inspect_bounded": inspect_bounded_runs,
    }
    handler = actions.get(action)
    if handler is None:
        raise Day18Phase8Error("unsupported action")
    if action in {"reserve", "record_msk_fault", "execute", "submit"}:
        initialize_mutation_schema()
    return handler(request)


def main() -> None:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise Day18Phase8Error("request must be an object")
        result = dispatch(request)
    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "errorType": type(error).__name__,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        raise SystemExit(1) from None
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
