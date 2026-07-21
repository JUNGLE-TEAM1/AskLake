from __future__ import annotations

import json

from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.models import KafkaContinuousSessionModel
from scripts.run_eks_day17_multi_spark import (
    candidate_contract_checks,
    collect_preflight,
    kubernetes_json,
)


ACTIVE_SPARK_STATES = {"SUBMITTED", "PENDING", "RUNNING", "FAILING"}
ACTIVE_CONTINUOUS_STATES = {"starting", "running", "stopping"}


def collect() -> dict[str, object]:
    preflight, facts = collect_preflight()
    candidate_checks = candidate_contract_checks(facts)
    namespace = "asklake-dev"
    applications = kubernetes_json(
        f"/apis/sparkoperator.k8s.io/v1beta2/namespaces/{namespace}/sparkapplications"
    ).get("items")
    if not isinstance(applications, list):
        raise RuntimeError("SparkApplication list returned an invalid document")
    active_applications = sum(
        1
        for application in applications
        if str(
            ((application.get("status") or {}).get("applicationState") or {}).get("state")
            or ""
        ).upper()
        in ACTIVE_SPARK_STATES
    )
    db = SessionLocal()
    try:
        continuous_active = int(
            db.scalar(
                select(func.count())
                .select_from(KafkaContinuousSessionModel)
                .where(KafkaContinuousSessionModel.status.in_(ACTIVE_CONTINUOUS_STATES))
            )
            or 0
        )
    finally:
        db.close()

    facts_by_alias = {fact.alias: fact for fact in facts}
    bounded = []
    for alias in ("Run A", "Run B", "Run C"):
        fact = facts_by_alias.get(alias)
        if fact is None:
            continue
        bounded.append(
            {
                "alias": alias,
                "jobId": fact.job_id,
                "datasetId": fact.dataset_id,
                "fixtureBatchId": fact.batch_id,
                "consumerGroup": fact.consumer_group,
                "icebergTable": fact.target_table,
                "expectedCount": fact.expected_count,
            }
        )
    faults = []
    for alias, source_alias, failure in (
        ("Run D", "Run A", "mskAuthorization"),
        ("Run E", "Run B", "sparkTerminal"),
    ):
        source = next(
            (target for target in bounded if target["alias"] == source_alias),
            None,
        )
        if source is not None:
            faults.append(
                {
                    **source,
                    "alias": alias,
                    "sourceAlias": source_alias,
                    "failure": failure,
                }
            )

    return {
        "status": "passed"
        if preflight.get("status") == "passed"
        and all(candidate_checks.values())
        and active_applications == 0
        and continuous_active == 0
        else "blocked",
        "preflight": {
            "status": preflight.get("status"),
            "activeFixtureRuns": int(
                (preflight.get("counts") or {}).get("activeFixtureRuns") or 0
            ),
            "airflowConfigured": bool(
                (preflight.get("checks") or {}).get("airflowConfigured")
            ),
            "sparkApplicationsReadable": bool(
                (preflight.get("checks") or {}).get(
                    "sparkApplicationListReadable"
                )
            ),
            "candidateChecksPassed": all(candidate_checks.values()),
        },
        "activeSparkApplications": active_applications,
        "continuousActive": continuous_active,
        "targets": {"bounded": bounded, "faults": faults},
    }


def main() -> None:
    try:
        result = collect()
    except Exception as error:
        result = {"status": "blocked", "error": type(error).__name__}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
