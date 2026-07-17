from __future__ import annotations

import hashlib
import json
import os
import ssl
import threading
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.request import Request, urlopen
from uuid import uuid4

from sqlalchemy import func, select

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.models import (
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
)
from app.services.airflow_client import build_airflow_client


FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1"
BATCH_FIELD = "__EKS MVP Fixture Batch ID"
COUNT_FIELD = "__EKS MVP Expected Count"
DEFAULT_GROUP = "asklake-eks-mvp-spark-v1"
DEFAULT_TABLE = "eks_mvp_fixture"
EXPECTED_COUNT = 100
REQUIRED_SCALE_SLOTS = (
    ("Run A", "asklake-eks-mvp-spark-scale17-01", "eks_mvp_scale_17_01"),
    ("Run B", "asklake-eks-mvp-spark-scale17-02", "eks_mvp_scale_17_02"),
    ("Run C", "asklake-eks-mvp-spark-scale17-03", "eks_mvp_scale_17_03"),
)
OPTIONAL_SCALE_SLOT = (
    "asklake-eks-mvp-spark-scale17-04",
    "eks_mvp_scale_17_04",
)
ACTIVE_RUN_STATUSES = ("queued", "running")


@dataclass(frozen=True)
class CandidateFact:
    alias: str
    batch_id: str
    consumer_group: str
    dataset_id: str
    execution_mode: str
    expected_count: int | None
    job_id: str
    target_table: str
    topic: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def short_hash(value: object) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:12]


def field_value(fields: Iterable[Iterable[object]], *labels: str) -> str:
    wanted = set(labels)
    for raw_item in fields:
        item = list(raw_item)
        if len(item) >= 2 and str(item[0]) in wanted:
            return str(item[1] or "").strip()
    return ""


def positive_integer(value: str) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def target_table(job: ETLJobModel) -> str:
    target = job.iceberg_target if isinstance(job.iceberg_target, dict) else {}
    return str(target.get("table") or "").strip()


def candidate_fact(job: ETLJobModel) -> CandidateFact | None:
    fields = job.source_config or []
    consumer_group = field_value(
        fields,
        "CONSUMER GROUP ID",
        "Consumer Group ID",
    )
    slot = next(
        (
            (alias, expected_group, expected_table)
            for alias, expected_group, expected_table in REQUIRED_SCALE_SLOTS
            if expected_group == consumer_group
        ),
        None,
    )
    if slot is None:
        return None
    alias, _, _ = slot
    return CandidateFact(
        alias=alias,
        batch_id=field_value(fields, BATCH_FIELD),
        consumer_group=consumer_group,
        dataset_id=str(job.dataset_id or "").strip(),
        execution_mode=str(job.execution_mode or "").strip(),
        expected_count=positive_integer(field_value(fields, COUNT_FIELD)),
        job_id=str(job.id),
        target_table=target_table(job),
        topic=field_value(
            fields,
            "TOPIC / QUEUE NAME",
            "Topic",
            "topic",
        ),
    )


def configured_runtime_slots() -> tuple[bool, list[tuple[str, str]]]:
    try:
        from app.services.etl_service import EKS_MVP_FIXTURE_CONTRACT_VERSION
        from scripts.kafka_fixture_slots import load_eks_fixture_slots

        slots = load_eks_fixture_slots(os.environ)
    except Exception:
        return False, []
    pairs = [(slot.consumer_group, slot.iceberg_table) for slot in slots]
    return EKS_MVP_FIXTURE_CONTRACT_VERSION == 2, pairs


def scale_slot_contract_valid(configured_slots: Iterable[tuple[str, str]]) -> bool:
    configured = set(configured_slots)
    required = {
        (DEFAULT_GROUP, DEFAULT_TABLE),
        *((group, table) for _, group, table in REQUIRED_SCALE_SLOTS),
    }
    allowed = {
        *required,
        OPTIONAL_SCALE_SLOT,
    }
    return required.issubset(configured) and configured.issubset(allowed)


def candidate_contract_checks(
    facts: list[CandidateFact],
) -> dict[str, bool]:
    by_alias = {
        alias: [fact for fact in facts if fact.alias == alias]
        for alias, _, _ in REQUIRED_SCALE_SLOTS
    }
    exact_candidates = len(facts) == 3 and all(
        len(alias_facts) == 1 for alias_facts in by_alias.values()
    )
    selected = [
        alias_facts[0]
        for alias_facts in by_alias.values()
        if len(alias_facts) == 1
    ]
    expected_tables = {
        alias: table for alias, _, table in REQUIRED_SCALE_SLOTS
    }
    batch_ids = {fact.batch_id for fact in selected if fact.batch_id}
    return {
        "candidateJobsExactlyThree": exact_candidates,
        "oneCandidatePerSlot": exact_candidates,
        "snapshotExecutionOnly": len(selected) == 3
        and all(fact.execution_mode == "snapshot" for fact in selected),
        "fixtureTopicExact": len(selected) == 3
        and all(fact.topic == FIXTURE_TOPIC for fact in selected),
        "fixtureBatchShared": len(selected) == 3 and len(batch_ids) == 1,
        "fixtureCountExact": len(selected) == 3
        and all(fact.expected_count == EXPECTED_COUNT for fact in selected),
        "consumerGroupsUnique": len(selected) == 3
        and len({fact.consumer_group for fact in selected}) == 3,
        "icebergTablesUnique": len(selected) == 3
        and len({fact.target_table for fact in selected}) == 3
        and all(
            fact.target_table == expected_tables[fact.alias]
            for fact in selected
        ),
        "datasetsUnique": len(selected) == 3
        and all(fact.dataset_id for fact in selected)
        and len({fact.dataset_id for fact in selected}) == 3,
    }


def replace_source_field(
    fields: Iterable[Iterable[object]],
    labels: set[str],
    value: str,
) -> list[list[str]]:
    replaced = False
    result: list[list[str]] = []
    for raw_item in fields:
        item = list(raw_item)
        if len(item) >= 2 and str(item[0]) in labels:
            result.append([str(item[0]), value])
            replaced = True
        else:
            result.append([str(part) for part in item])
    if not replaced:
        raise RuntimeError("fixture template is missing a required source field")
    return result


def candidate_job_values(
    template: ETLJobModel,
    *,
    index: int,
    consumer_group: str,
    iceberg_table: str,
    nonce: str,
) -> dict[str, Any]:
    target = deepcopy(template.iceberg_target or {})
    catalog = str(target.get("catalog") or "").strip()
    namespace = str(target.get("namespace") or "").strip()
    if not catalog or not namespace:
        raise RuntimeError("fixture template Iceberg target is unavailable")
    target["table"] = iceberg_table
    target["tableUri"] = f"iceberg://{catalog}/{namespace}/{iceberg_table}"
    target["writeMode"] = "replace"
    target["partitionColumns"] = []

    suffix = f"{index:02d}-{nonce}"
    dataset_name = f"eks_day17_candidate_{index:02d}_{nonce}"
    values = {
        column.key: deepcopy(getattr(template, column.key))
        for column in template.__table__.columns
        if column.key not in {"created_at", "updated_at"}
    }
    values.update(
        {
            "id": f"JOB-EKS-D17-{suffix}",
            "name": f"EKS Day 17 isolated candidate {index}",
            "created_by": "day17-multi-spark-prep",
            "created_by_profile": {
                "name": "day17-multi-spark-prep",
                "role": "admin",
            },
            "status": "scheduled",
            "tag": "[EKS-D17]",
            "target": dataset_name,
            "source_config": replace_source_field(
                template.source_config or [],
                {"CONSUMER GROUP ID", "Consumer Group ID"},
                consumer_group,
            ),
            "iceberg_target": target,
            "storage_path": target["tableUri"],
            "target_path": target["tableUri"],
            "dataset_id": f"dataset-eks-d17-{suffix}",
            "last_run": "생성 후 미실행",
            "last_state": "EKS Day 17 isolated candidate",
            "progress": None,
            "dag_steps_by_run_id": {},
        }
    )
    return values


def default_fixture_template(db) -> ETLJobModel | None:
    successful_runs = db.scalars(
        select(ETLRunModel)
        .where(ETLRunModel.status == "success")
        .order_by(ETLRunModel.created_at.desc())
    ).all()
    for run in successful_runs:
        job = db.get(ETLJobModel, run.job_id)
        if job is None or str(job.execution_mode or "") != "snapshot":
            continue
        fields = job.source_config or []
        batch_id = field_value(fields, BATCH_FIELD)
        if (
            field_value(fields, "TOPIC / QUEUE NAME", "Topic", "topic")
            != FIXTURE_TOPIC
            or field_value(
                fields,
                "CONSUMER GROUP ID",
                "Consumer Group ID",
            )
            != DEFAULT_GROUP
            or positive_integer(field_value(fields, COUNT_FIELD))
            != EXPECTED_COUNT
            or not batch_id
        ):
            continue
        state = (run.task_states or {}).get("eksMvpFixture")
        boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        if (
            isinstance(boundary, dict)
            and boundary.get("topic") == FIXTURE_TOPIC
            and boundary.get("consumerGroup") == DEFAULT_GROUP
            and boundary.get("fixtureBatchId") == batch_id
            and boundary.get("expectedCount") == EXPECTED_COUNT
        ):
            return job
    return None


def evaluate_preflight(
    *,
    active_run_counts: dict[str, int],
    airflow_configured: bool,
    backend_multi_slot_available: bool,
    configured_slots: list[tuple[str, str]],
    continuous_runtime_count: int,
    continuous_session_count: int,
    facts: list[CandidateFact],
    spark_application_list_readable: bool,
) -> dict[str, Any]:
    candidate_checks = candidate_contract_checks(facts)
    slots_configured = scale_slot_contract_valid(configured_slots)
    slots_idle = len(active_run_counts) == 3 and all(
        active_run_counts.get(group) == 0
        for _, group, _ in REQUIRED_SCALE_SLOTS
    )
    checks = {
        "backendMultiSlotAvailable": backend_multi_slot_available,
        "scaleSlotsConfigured": slots_configured,
        **candidate_checks,
        "fixtureSlotsIdle": slots_idle,
        "sparkApplicationListReadable": spark_application_list_readable,
        "airflowConfigured": airflow_configured,
    }
    blockers: list[str] = []
    if not backend_multi_slot_available:
        blockers.append("Backend multi-slot runtime unavailable")
    if not slots_configured:
        blockers.append("scale slots not configured")
    if not (
        candidate_checks["candidateJobsExactlyThree"]
        and candidate_checks["oneCandidatePerSlot"]
    ):
        blockers.append("candidate jobs missing")
    if not all(
        value
        for name, value in candidate_checks.items()
        if name not in {"candidateJobsExactlyThree", "oneCandidatePerSlot"}
    ):
        blockers.append("candidate fixture boundary invalid")
    if not slots_idle:
        blockers.append("fixture scale slot active")
    if not spark_application_list_readable:
        blockers.append("SparkApplication RBAC unavailable")
    if not airflow_configured:
        blockers.append("Airflow runtime unavailable")
    return {
        "contractVersion": "1.0",
        "status": "passed" if all(checks.values()) else "blocked",
        "checkedAt": utc_now(),
        "checks": checks,
        "counts": {
            "scaleSlots": sum(
                1
                for _, group, table in REQUIRED_SCALE_SLOTS
                if (group, table) in set(configured_slots)
            ),
            "candidateJobs": len(facts),
            "activeFixtureRuns": sum(active_run_counts.values()),
            "continuousRuntimes": continuous_runtime_count,
            "continuousSessions": continuous_session_count,
        },
        "isolation": {
            "consumerGroups": len({fact.consumer_group for fact in facts}),
            "icebergTables": len({fact.target_table for fact in facts if fact.target_table}),
            "datasets": len({fact.dataset_id for fact in facts if fact.dataset_id}),
        },
        "blockers": blockers,
    }


def kubernetes_json(path: str) -> dict[str, Any]:
    host = str(os.environ.get("KUBERNETES_SERVICE_HOST") or "").strip()
    if not host:
        raise RuntimeError("Kubernetes service host is unavailable")
    port = str(os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS") or "443")
    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    with open(token_path, encoding="utf-8") as token_file:
        token = token_file.read().strip()
    request = Request(
        f"https://{host}:{port}{path}",
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    context = ssl.create_default_context(cafile=ca_path)
    with urlopen(request, timeout=20, context=context) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError("Kubernetes API returned an invalid document")
    return parsed


def spark_application_list_readable() -> bool:
    namespace = str(
        os.environ.get("ASKLAKE_SPARK_KUBERNETES_NAMESPACE")
        or os.environ.get("POD_NAMESPACE")
        or "asklake-dev"
    ).strip()
    try:
        document = kubernetes_json(
            f"/apis/sparkoperator.k8s.io/v1beta2/namespaces/{namespace}/sparkapplications"
        )
    except Exception:
        return False
    return isinstance(document.get("items"), list)


def active_run_counts(db) -> dict[str, int]:
    counts = {
        group: 0 for _, group, _ in REQUIRED_SCALE_SLOTS
    }
    runs = db.scalars(
        select(ETLRunModel).where(ETLRunModel.status.in_(ACTIVE_RUN_STATUSES))
    ).all()
    for run in runs:
        state = (run.task_states or {}).get("eksMvpFixture")
        boundary = state.get("sourceBoundary") if isinstance(state, dict) else None
        group = (
            str(boundary.get("consumerGroup") or "").strip()
            if isinstance(boundary, dict)
            else ""
        )
        if group in counts:
            counts[group] += 1
    return counts


def collect_preflight() -> tuple[dict[str, Any], list[CandidateFact]]:
    backend_available, slots = configured_runtime_slots()
    db = SessionLocal()
    try:
        jobs = db.scalars(select(ETLJobModel)).all()
        facts = [
            fact
            for job in jobs
            if (fact := candidate_fact(job)) is not None
        ]
        active = active_run_counts(db)
        continuous_runtimes = int(
            db.scalar(select(func.count()).select_from(KafkaContinuousRuntimeModel))
            or 0
        )
        continuous_sessions = int(
            db.scalar(select(func.count()).select_from(KafkaContinuousSessionModel))
            or 0
        )
    finally:
        db.close()
    try:
        airflow = build_airflow_client()
        airflow_configured = bool(
            airflow.config.api_base_url and airflow.config.dag_id
        )
    except Exception:
        airflow_configured = False
    result = evaluate_preflight(
        active_run_counts=active,
        airflow_configured=airflow_configured,
        backend_multi_slot_available=backend_available,
        configured_slots=slots,
        continuous_runtime_count=continuous_runtimes,
        continuous_session_count=continuous_sessions,
        facts=facts,
        spark_application_list_readable=spark_application_list_readable(),
    )
    return result, facts


def prepare_candidate_jobs() -> dict[str, Any]:
    preflight, facts = collect_preflight()
    candidate_checks = candidate_contract_checks(facts)
    if all(candidate_checks.values()):
        return {
            "contractVersion": "1.0",
            "status": "prepared",
            "createdAt": utc_now(),
            "created": False,
            "counts": {
                "candidateJobs": 3,
                "createdRuns": 0,
            },
            "redactedJobs": [
                {
                    "alias": fact.alias,
                    "job": short_hash(fact.job_id),
                    "dataset": short_hash(fact.dataset_id),
                }
                for fact in sorted(facts, key=lambda item: item.alias)
            ],
        }
    if facts:
        return blocked_result("candidate jobs require manual reconciliation")

    required_checks = (
        "backendMultiSlotAvailable",
        "scaleSlotsConfigured",
        "fixtureSlotsIdle",
        "sparkApplicationListReadable",
        "airflowConfigured",
    )
    if not all(preflight["checks"].get(name) for name in required_checks):
        return blocked_result("candidate preparation prerequisites unavailable")

    db = SessionLocal()
    try:
        template = default_fixture_template(db)
        if template is None:
            return blocked_result("successful bounded fixture template unavailable")
        run_count_before = int(
            db.scalar(select(func.count()).select_from(ETLRunModel)) or 0
        )
        continuous_runtime_count_before = int(
            db.scalar(
                select(func.count()).select_from(KafkaContinuousRuntimeModel)
            )
            or 0
        )
        continuous_session_count_before = int(
            db.scalar(
                select(func.count()).select_from(KafkaContinuousSessionModel)
            )
            or 0
        )
        nonce = uuid4().hex[:10]
        candidates = [
            ETLJobModel(
                **candidate_job_values(
                    template,
                    index=index,
                    consumer_group=group,
                    iceberg_table=table,
                    nonce=nonce,
                )
            )
            for index, (_, group, table) in enumerate(
                REQUIRED_SCALE_SLOTS,
                start=1,
            )
        ]
        db.add_all(candidates)
        db.commit()

        run_count_after = int(
            db.scalar(select(func.count()).select_from(ETLRunModel)) or 0
        )
        continuous_runtime_count_after = int(
            db.scalar(
                select(func.count()).select_from(KafkaContinuousRuntimeModel)
            )
            or 0
        )
        continuous_session_count_after = int(
            db.scalar(
                select(func.count()).select_from(KafkaContinuousSessionModel)
            )
            or 0
        )
        prepared_facts = [
            fact
            for job in db.scalars(select(ETLJobModel)).all()
            if (fact := candidate_fact(job)) is not None
        ]
        checks = candidate_contract_checks(prepared_facts)
        checks.update(
            {
                "createdRunsZero": run_count_after == run_count_before,
                "continuousRuntimesUnchanged": (
                    continuous_runtime_count_after
                    == continuous_runtime_count_before
                ),
                "continuousSessionsUnchanged": (
                    continuous_session_count_after
                    == continuous_session_count_before
                ),
            }
        )
        if not all(checks.values()):
            return blocked_result("candidate preparation postcheck failed")
        return {
            "contractVersion": "1.0",
            "status": "prepared",
            "createdAt": utc_now(),
            "created": True,
            "checks": checks,
            "counts": {
                "candidateJobs": len(prepared_facts),
                "createdRuns": run_count_after - run_count_before,
                "continuousRuntimes": continuous_runtime_count_after,
                "continuousSessions": continuous_session_count_after,
            },
            "redactedJobs": [
                {
                    "alias": fact.alias,
                    "job": short_hash(fact.job_id),
                    "dataset": short_hash(fact.dataset_id),
                }
                for fact in sorted(
                    prepared_facts,
                    key=lambda item: item.alias,
                )
            ],
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def submit_runs() -> dict[str, Any]:
    preflight, facts = collect_preflight()
    if preflight["status"] != "passed":
        return preflight
    facts_by_alias = {fact.alias: fact for fact in facts}
    barrier = threading.Barrier(3)
    result_lock = threading.Lock()
    submitted: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    def submit_one(alias: str) -> None:
        fact = facts_by_alias[alias]
        db = SessionLocal()
        try:
            barrier.wait(timeout=20)
            from app.services.etl_service import command_job

            response = command_job(
                db,
                fact.job_id,
                "run",
                ActorContext(name="day17-multi-spark", role="admin"),
            )
            run_id = str(response.run.run_id)
            db.expire_all()
            run = db.get(ETLRunModel, run_id)
            state = (
                (run.task_states or {}).get("eksMvpFixture")
                if run is not None
                else None
            )
            boundary = (
                state.get("sourceBoundary")
                if isinstance(state, dict)
                else None
            )
            table = (
                str(state.get("icebergTable") or "").strip()
                if isinstance(state, dict)
                else ""
            )
            if not isinstance(boundary, dict):
                raise RuntimeError("persisted fixture boundary is missing")
            private = {
                "alias": alias,
                "jobId": fact.job_id,
                "runId": run_id,
                "datasetId": fact.dataset_id,
                "consumerGroup": str(boundary.get("consumerGroup") or ""),
                "icebergTable": table,
                "outputPath": str(boundary.get("outputPath") or ""),
                "checkpointPath": str(boundary.get("checkpointPath") or ""),
                "fixtureBatchId": str(boundary.get("fixtureBatchId") or ""),
                "expectedCount": int(boundary.get("expectedCount") or 0),
            }
            with result_lock:
                submitted.append(private)
        except Exception as exc:
            with result_lock:
                failures.append(
                    {
                        "alias": alias,
                        "errorType": type(exc).__name__,
                        "errorCode": str(getattr(exc, "code", "") or "unavailable"),
                    }
                )
        finally:
            db.close()

    threads = [
        threading.Thread(target=submit_one, args=(alias,), daemon=True)
        for alias, _, _ in REQUIRED_SCALE_SLOTS
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
    for alias, thread in zip(
        (slot[0] for slot in REQUIRED_SCALE_SLOTS),
        threads,
        strict=True,
    ):
        if thread.is_alive():
            failures.append(
                {
                    "alias": alias,
                    "errorType": "SubmissionTimeout",
                    "errorCode": "unavailable",
                }
            )

    submitted.sort(key=lambda item: item["alias"])
    groups = {item["consumerGroup"] for item in submitted}
    tables = {item["icebergTable"] for item in submitted}
    outputs = {item["outputPath"] for item in submitted}
    checkpoints = {item["checkpointPath"] for item in submitted}
    run_ids = {item["runId"] for item in submitted}
    checks = {
        "submittedExactlyThree": len(submitted) == 3 and not failures,
        "runIdsUnique": len(run_ids) == 3,
        "consumerGroupsUnique": len(groups) == 3,
        "icebergTablesUnique": len(tables) == 3,
        "outputsUnique": len(outputs) == 3 and "" not in outputs,
        "checkpointsUnique": len(checkpoints) == 3 and "" not in checkpoints,
        "expectedCountExact": len(submitted) == 3
        and all(item["expectedCount"] == EXPECTED_COUNT for item in submitted),
    }
    status = "submitted" if all(checks.values()) else "partial"
    return {
        "contractVersion": "1.0",
        "status": status,
        "createdAt": utc_now(),
        "checks": checks,
        "counts": {
            "submittedRuns": len(submitted),
            "failedSubmissions": len(failures),
            "consumerGroups": len(groups),
            "icebergTables": len(tables),
            "outputs": len(outputs),
            "checkpoints": len(checkpoints),
        },
        "failures": failures,
        "redactedRuns": [
            {
                "alias": item["alias"],
                "run": short_hash(item["runId"]),
                "job": short_hash(item["jobId"]),
                "dataset": short_hash(item["datasetId"]),
            }
            for item in submitted
        ],
        "privateIdentity": submitted,
        "warning": (
            "Do not resubmit automatically; inspect this receipt and the observer."
            if status != "submitted"
            else ""
        ),
    }


def blocked_result(blocker: str) -> dict[str, Any]:
    return {
        "contractVersion": "1.0",
        "status": "blocked",
        "checkedAt": utc_now(),
        "checks": {},
        "counts": {},
        "blockers": [blocker],
    }


def main() -> None:
    mode = str(os.environ.get("DAY17_MULTI_SPARK_MODE") or "preflight").strip()
    try:
        if mode == "preflight":
            result, _ = collect_preflight()
        elif mode == "prepare":
            result = prepare_candidate_jobs()
        elif mode == "submit":
            result = submit_runs()
        else:
            result = blocked_result("unsupported runner mode")
    except Exception:
        result = blocked_result("RDS or runtime read unavailable")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
