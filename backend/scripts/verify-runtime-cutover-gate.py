#!/usr/bin/env python3
"""Fail-closed production preflight for a Phase 8 Runtime promotion report."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


CUTOVER_REPORT_SCHEMA = "asklake.runtime-cutover-report.v1"
PLAN_SCHEMA = "asklake.runtime-cutover-plan.v1"
POLICY_SCHEMA = "asklake.runtime-cutover-policy.v1"
EVIDENCE_SCHEMA = "asklake.runtime-cutover-evidence.v1"
PHASE7_REPORT_SCHEMA = "asklake.streaming-performance-report.v1"
DEFAULT_SPARK_RUNTIME = "spark-rest"
DEFAULT_KAFKA_RUNTIME = "redpanda"
REVISION_RE = re.compile(r"^[a-f0-9]{40}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
EXPECTED_STATIC_GATES = {
    "phase7-approved-report",
    "operational-evidence",
    "evidence-environment",
    "target-region",
    "candidate-spark-runtime",
    "candidate-kafka-runtime",
    "baseline-spark-runtime",
    "baseline-kafka-runtime",
    "candidate-differs-from-baseline",
    "stage:docker-regression",
    "stage:aws-batch-staging",
    "stage:aws-continuous-staging",
    "stage:small-workload-cutover",
    "shadow-topic",
    "consumer-group-isolation",
    "output-prefix-isolation",
    "checkpoint-isolation",
    "shadow-repeat-count",
    "comparable-input",
    "stored-count-delta",
    "quarantine-count-delta",
    "schema-match",
    "value-checksum-match",
    "quarantine-checksum-match",
    "observation-duration",
    "observation-error-rate",
    "observation-max-lag",
    "observation-p95-latency",
    "observation-cost",
    "rollback-target",
    "rollback-tested",
    "escalation-owner",
    "promotion-approval",
    "automatic-promotion-disabled",
    "chronology:phase7-before-phase8",
    "chronology:stage-order",
    "chronology:observation-after-small-workload",
    "chronology:approval-after-observation",
    "chronology:rollback-test-before-approval",
    "chronology:no-future-evidence",
}
REQUIRED_STAGE_EVIDENCE = {
    "docker-regression",
    "aws-batch-staging",
    "aws-continuous-staging",
    "small-workload-cutover",
}
THRESHOLD_NAMES = {
    "maxStoredCountDelta",
    "maxQuarantineCountDelta",
    "maxErrorRate",
    "maxLag",
    "maxP95LatencyMs",
    "maxCostUsd",
}
PHASE7_SCENARIOS = {
    "small-steady",
    "ramp",
    "burst",
    "backlog",
    "capacity-cap",
    "scale-down",
    "multi-continuous",
    "continuous-with-batch",
    "kafka-disconnect",
    "s3-write-failure",
    "schema-quarantine-surge",
    "emr-job-failure",
    "backend-restart",
    "checkpoint-permission",
    "invalid-authentication",
    "poison-records",
}
PLAN_STAGES = [
    "docker-regression",
    "aws-batch-staging",
    "aws-continuous-staging",
    "shadow-isolation",
    "result-comparison",
    "small-workload-cutover",
    "observation",
    "promotion-approval",
    "rollback-readiness",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--phase7-report", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--repository-root", required=True, type=Path)
    return parser.parse_args()


def fail(message: str) -> None:
    raise ValueError(message)


def load_json(path: Path, name: str) -> tuple[dict[str, Any], bytes]:
    if not path.is_absolute():
        fail(f"{name} path must be absolute: {path}")
    try:
        raw = path.read_bytes()
    except OSError as error:
        fail(f"{name} is not readable: {path}: {error}")
    try:
        def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, item in pairs:
                if key in result:
                    fail(f"{name} contains duplicate JSON key: {key}")
                result[key] = item
            return result

        value = json.loads(
            raw,
            object_pairs_hook=reject_duplicates,
            parse_constant=lambda constant: fail(f"{name} contains invalid numeric constant: {constant}"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{name} is not valid JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{name} must contain a JSON object")
    return value, raw


def load_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"deployment env file is not readable: {path}: {error}")
    result: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = raw
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        result[key] = value
    return result


def require_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        fail(f"{label} mismatch: expected {expected!r}, got {actual!r}")


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        fail(f"{label} must be a non-empty single line")
    return value.strip()


def require_iso(value: Any, label: str) -> str:
    text = require_text(value, label)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} must be an ISO timestamp")
    if parsed.tzinfo is None:
        fail(f"{label} must include a timezone")
    return text


def iso_datetime(value: Any, label: str) -> datetime:
    text = require_iso(value, label)
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def require_number(value: Any, label: str, *, integer: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        fail(f"{label} must be a non-negative number")
    if integer and not isinstance(value, int):
        fail(f"{label} must be a non-negative integer")
    return float(value)


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    return value


def require_passed_gates(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        fail(f"{label} must be a non-empty list")
    gates: list[dict[str, Any]] = []
    for index, gate_value in enumerate(value):
        gate = require_object(gate_value, f"{label}[{index}]")
        require_text(gate.get("name"), f"{label}[{index}].name")
        require_equal(gate.get("status"), "passed", f"{label}[{index}].status")
        gates.append(gate)
    return gates


def repository_revision(root: Path) -> str:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().lower()
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"cannot determine deployed git revision: {error}")
    if not REVISION_RE.fullmatch(revision):
        fail("deployed git revision must be a full 40-character commit SHA")
    return revision


def validate_phase7(report: dict[str, Any], raw: bytes, embedded: dict[str, Any]) -> None:
    require_equal(report.get("schemaVersion"), PHASE7_REPORT_SCHEMA, "Phase 7 report schemaVersion")
    require_equal(report.get("status"), "passed", "Phase 7 report status")
    require_equal(report.get("evidenceKind"), "operational", "Phase 7 report evidenceKind")
    profile = report.get("profile")
    if not isinstance(profile, dict):
        fail("Phase 7 report profile must be an object")
    require_equal(profile.get("approvalStatus"), "approved", "Phase 7 profile approvalStatus")
    approved_by = require_text(profile.get("approvedBy"), "Phase 7 profile approvedBy")
    approved_at = require_iso(profile.get("approvedAt"), "Phase 7 profile approvedAt")
    minimum_runs = int(require_number(profile.get("minimumSuccessfulRuns"), "Phase 7 profile minimumSuccessfulRuns", integer=True))
    if minimum_runs <= 0:
        fail("Phase 7 profile minimumSuccessfulRuns must be positive")
    coverage = require_object(report.get("scenarioCoverage"), "Phase 7 scenarioCoverage")
    required_scenarios = coverage.get("requiredScenarioIds")
    missing_scenarios = coverage.get("missingScenarioIds")
    if not isinstance(required_scenarios, list) or set(required_scenarios) != PHASE7_SCENARIOS or len(required_scenarios) != len(PHASE7_SCENARIOS):
        fail("Phase 7 report must require every v1 load and fault scenario")
    require_equal(missing_scenarios, [], "Phase 7 missingScenarioIds")
    scenarios = report.get("scenarios")
    if not isinstance(scenarios, list) or len(scenarios) != len(PHASE7_SCENARIOS):
        fail("Phase 7 report must contain every v1 scenario evaluation")
    scenario_ids: set[str] = set()
    for index, scenario_value in enumerate(scenarios):
        scenario = require_object(scenario_value, f"Phase 7 scenarios[{index}]")
        scenario_id = require_text(scenario.get("scenarioId"), f"Phase 7 scenarios[{index}].scenarioId")
        scenario_ids.add(scenario_id)
        require_equal(scenario.get("status"), "passed", f"Phase 7 scenario {scenario_id} status")
        run_count = int(require_number(scenario.get("runCount"), f"Phase 7 scenario {scenario_id} runCount", integer=True))
        if run_count < minimum_runs:
            fail(f"Phase 7 scenario {scenario_id} is below the approved repeat count")
        require_passed_gates(scenario.get("gates"), f"Phase 7 scenario {scenario_id} gates")
        runs = scenario.get("runs")
        if not isinstance(runs, list) or len(runs) != run_count:
            fail(f"Phase 7 scenario {scenario_id} runs must match runCount")
        for run_index, run_value in enumerate(runs):
            run = require_object(run_value, f"Phase 7 scenario {scenario_id} runs[{run_index}]")
            require_text(run.get("runId"), f"Phase 7 scenario {scenario_id} runs[{run_index}].runId")
            require_equal(run.get("status"), "passed", f"Phase 7 scenario {scenario_id} runs[{run_index}].status")
            require_passed_gates(run.get("gates"), f"Phase 7 scenario {scenario_id} runs[{run_index}].gates")
    require_equal(scenario_ids, PHASE7_SCENARIOS, "Phase 7 scenario IDs")
    digest = hashlib.sha256(raw).hexdigest()
    if not SHA256_RE.fullmatch(digest):
        fail("Phase 7 report SHA-256 could not be calculated")
    require_equal(embedded.get("sha256"), digest, "embedded Phase 7 report SHA-256")
    require_equal(embedded.get("schemaVersion"), PHASE7_REPORT_SCHEMA, "embedded Phase 7 schemaVersion")
    require_equal(embedded.get("status"), "passed", "embedded Phase 7 status")
    require_equal(embedded.get("evidenceKind"), "operational", "embedded Phase 7 evidenceKind")
    require_equal(embedded.get("approvalStatus"), "approved", "embedded Phase 7 approvalStatus")
    require_equal(embedded.get("profileId"), profile.get("profileId"), "embedded Phase 7 profileId")
    require_equal(embedded.get("approvedBy"), approved_by, "embedded Phase 7 approvedBy")
    require_equal(iso_datetime(embedded.get("approvedAt"), "embedded Phase 7 approvedAt"), iso_datetime(approved_at, "Phase 7 approvedAt"), "embedded Phase 7 approvedAt")


def validate_runtime_identity(value: Any, label: str) -> dict[str, Any]:
    identity = require_object(value, label)
    spark_runtime = require_text(identity.get("sparkRuntime"), f"{label}.sparkRuntime").lower()
    kafka_runtime = require_text(identity.get("kafkaRuntime"), f"{label}.kafkaRuntime").lower()
    if spark_runtime not in {"spark-rest", "emr-serverless"} or kafka_runtime not in {"redpanda", "msk"}:
        fail(f"{label} contains an unsupported Runtime")
    return {
        "sparkRuntime": spark_runtime,
        "kafkaRuntime": kafka_runtime,
        "topic": require_text(identity.get("topic"), f"{label}.topic"),
        "consumerGroup": require_text(identity.get("consumerGroup"), f"{label}.consumerGroup"),
        "outputPrefix": normalize_object_storage_uri(identity.get("outputPrefix"), f"{label}.outputPrefix"),
        "checkpointPath": normalize_object_storage_uri(identity.get("checkpointPath"), f"{label}.checkpointPath"),
    }


def normalize_object_storage_uri(value: Any, label: str) -> str:
    normalized = require_text(value, label).rstrip("/")
    if not re.fullmatch(r"s3a?://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+", normalized):
        fail(f"{label} must be an S3/S3A prefix without query or fragment")
    path = normalized.split("/", 3)[3]
    if re.search(r"(?:^|/)\.\.?(?:/|$)", path) or re.search(r"%(?:2e|2f|5c)", path, re.IGNORECASE) or "//" in path:
        fail(f"{label} contains an unsafe path segment")
    return re.sub(r"^s3://", "s3a://", normalized)


def paths_overlap(left: str, right: str) -> bool:
    left = left.rstrip("/")
    right = right.rstrip("/")
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def validate_cutover(report: dict[str, Any], env: dict[str, str], revision: str) -> None:
    require_equal(report.get("schemaVersion"), CUTOVER_REPORT_SCHEMA, "cutover report schemaVersion")
    require_equal(report.get("status"), "promotion-ready", "cutover report status")
    require_equal(report.get("evidenceKind"), "operational", "cutover report evidenceKind")
    require_iso(report.get("generatedAt"), "cutover generatedAt")
    approval = report.get("approval")
    if not isinstance(approval, dict):
        fail("cutover report approval must be an object")
    require_equal(approval.get("status"), "approved", "cutover approval status")
    require_text(approval.get("approvedBy"), "cutover approvedBy")
    require_iso(approval.get("approvedAt"), "cutover approvedAt")
    require_text(approval.get("changeTicket"), "cutover changeTicket")
    gates = report.get("gates")
    if not isinstance(gates, list) or not gates:
        fail("cutover report must contain promotion gates")
    if any(not isinstance(gate, dict) or gate.get("status") != "passed" for gate in gates):
        fail("every cutover report gate must be passed")
    gate_names = [gate.get("name") for gate in gates]
    if any(not isinstance(name, str) for name in gate_names) or len(set(gate_names)) != len(gate_names):
        fail("cutover report gate names must be non-empty and unique")
    dynamic_gates = {name for name in gate_names if re.fullmatch(r"run:[A-Za-z0-9._-]+:(?:baseline|candidate)-integrity", name)}
    if set(gate_names) != EXPECTED_STATIC_GATES | dynamic_gates:
        fail("cutover report gate set does not match the v1 contract")
    target = report.get("target")
    if not isinstance(target, dict):
        fail("cutover report target must be an object")
    require_equal(target.get("appEnvironment"), env.get("APP_ENV"), "target appEnvironment")
    require_equal(target.get("storageEnvironment"), env.get("ASKLAKE_STORAGE_ENVIRONMENT"), "target storageEnvironment")
    require_equal(target.get("region"), env.get("AWS_REGION"), "target region")
    require_equal(target.get("sparkRuntime"), env.get("ASKLAKE_SPARK_RUNTIME"), "target Spark Runtime")
    require_equal(target.get("kafkaRuntime"), env.get("ASKLAKE_KAFKA_RUNTIME"), "target Kafka Runtime")
    require_equal(target.get("sourceRevision"), revision, "target sourceRevision")
    require_text(report.get("planId"), "cutover planId")
    require_text(report.get("policyId"), "cutover policyId")

    baseline = validate_runtime_identity(report.get("baseline"), "baseline")
    candidate = validate_runtime_identity(report.get("candidate"), "candidate")
    require_equal(baseline.get("sparkRuntime"), DEFAULT_SPARK_RUNTIME, "baseline Spark Runtime")
    require_equal(baseline.get("kafkaRuntime"), DEFAULT_KAFKA_RUNTIME, "baseline Kafka Runtime")
    require_equal(candidate.get("sparkRuntime"), target.get("sparkRuntime"), "candidate Spark Runtime")
    require_equal(candidate.get("kafkaRuntime"), target.get("kafkaRuntime"), "candidate Kafka Runtime")
    require_equal(candidate.get("topic"), baseline.get("topic"), "shadow topic")
    if candidate.get("consumerGroup") == baseline.get("consumerGroup"):
        fail("baseline and candidate consumer groups must be distinct")
    if paths_overlap(baseline["outputPrefix"], candidate["outputPrefix"]):
        fail("baseline and candidate output prefixes must be disjoint")
    if paths_overlap(baseline["checkpointPath"], candidate["checkpointPath"]):
        fail("baseline and candidate checkpoints must be disjoint")

    stage_evidence = require_object(report.get("stageEvidence"), "stageEvidence")
    require_equal(set(stage_evidence), REQUIRED_STAGE_EVIDENCE, "stageEvidence names")
    for stage, item_value in stage_evidence.items():
        item = require_object(item_value, f"stageEvidence.{stage}")
        require_equal(item.get("status"), "passed", f"stageEvidence.{stage}.status")
        require_iso(item.get("completedAt"), f"stageEvidence.{stage}.completedAt")
        if not SHA256_RE.fullmatch(str(item.get("evidenceSha256") or "")):
            fail(f"stageEvidence.{stage}.evidenceSha256 must be a SHA-256 digest")
        normalize_object_storage_uri(item.get("artifactRef"), f"stageEvidence.{stage}.artifactRef")

    criteria = require_object(report.get("criteria"), "criteria")
    minimum_runs = require_number(criteria.get("minimumShadowRuns"), "criteria.minimumShadowRuns", integer=True)
    minimum_minutes = require_number(criteria.get("minimumObservationMinutes"), "criteria.minimumObservationMinutes")
    if minimum_runs <= 0 or minimum_minutes <= 0:
        fail("cutover minimum run and observation criteria must be positive")
    thresholds = require_object(criteria.get("thresholds"), "criteria.thresholds")
    require_equal(set(thresholds), THRESHOLD_NAMES, "criteria threshold names")
    for name, value in thresholds.items():
        require_number(value, f"criteria.thresholds.{name}")
    if thresholds["maxErrorRate"] > 1:
        fail("criteria.thresholds.maxErrorRate must be between 0 and 1")
    for name in ("requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"):
        require_equal(criteria.get(name), True, f"criteria.{name}")

    summary = require_object(report.get("shadowSummary"), "shadowSummary")
    run_count = int(require_number(summary.get("runCount"), "shadowSummary.runCount", integer=True))
    if run_count < minimum_runs:
        fail("shadow run count is below the approved minimum")
    require_equal(summary.get("integrityFailureSides"), 0, "shadow integrityFailureSides")
    if require_number(summary.get("maxStoredCountDelta"), "shadowSummary.maxStoredCountDelta") > thresholds["maxStoredCountDelta"]:
        fail("shadow stored count delta exceeds the approved threshold")
    if require_number(summary.get("maxQuarantineCountDelta"), "shadowSummary.maxQuarantineCountDelta") > thresholds["maxQuarantineCountDelta"]:
        fail("shadow quarantine count delta exceeds the approved threshold")
    for summary_name, criterion_name in (
        ("schemaMismatchRuns", "requireSchemaMatch"),
        ("valueMismatchRuns", "requireValueChecksumMatch"),
        ("quarantineMismatchRuns", "requireQuarantineChecksumMatch"),
    ):
        mismatch_count = require_number(summary.get(summary_name), f"shadowSummary.{summary_name}", integer=True)
        if criteria[criterion_name] and mismatch_count != 0:
            fail(f"shadowSummary.{summary_name} must be zero")
    run_sides: dict[str, set[str]] = {}
    for name in dynamic_gates:
        match = re.fullmatch(r"run:([A-Za-z0-9._-]+):(baseline|candidate)-integrity", name)
        assert match is not None
        run_sides.setdefault(match.group(1), set()).add(match.group(2))
    if len(run_sides) != run_count or any(sides != {"baseline", "candidate"} for sides in run_sides.values()):
        fail("cutover report must contain both integrity gates for every shadow run")

    observation = require_object(report.get("observation"), "observation")
    if require_number(observation.get("durationMinutes"), "observation.durationMinutes") < minimum_minutes:
        fail("observation duration is below the approved minimum")
    for metric, threshold in (
        ("errorRate", "maxErrorRate"),
        ("maxLag", "maxLag"),
        ("p95LatencyMs", "maxP95LatencyMs"),
        ("costUsd", "maxCostUsd"),
    ):
        if require_number(observation.get(metric), f"observation.{metric}") > thresholds[threshold]:
            fail(f"observation.{metric} exceeds the approved threshold")

    rollback = require_object(report.get("rollback"), "rollback")
    require_equal(rollback.get("sparkRuntime"), DEFAULT_SPARK_RUNTIME, "rollback Spark Runtime")
    require_equal(rollback.get("kafkaRuntime"), DEFAULT_KAFKA_RUNTIME, "rollback Kafka Runtime")
    require_iso(rollback.get("lastTestedAt"), "rollback lastTestedAt")
    require_text(rollback.get("owner"), "rollback owner")
    runbook_ref = require_text(rollback.get("runbookRef"), "rollback runbookRef")
    if not re.fullmatch(r"(?:docs|scripts)/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?", runbook_ref) or ".." in runbook_ref:
        fail("rollback runbookRef must reference a safe docs/ or scripts/ path")
    if not REVISION_RE.fullmatch(str(rollback.get("previousGoodRevision") or "")):
        fail("rollback previousGoodRevision must be a full commit SHA")
    escalation = require_object(report.get("escalation"), "escalation")
    require_text(escalation.get("owner"), "escalation owner")
    require_text(escalation.get("channel"), "escalation channel")


def validate_source_artifacts(
    report: dict[str, Any],
    plan_artifact: tuple[dict[str, Any], bytes],
    policy_artifact: tuple[dict[str, Any], bytes],
    evidence_artifact: tuple[dict[str, Any], bytes],
    phase7_artifact: tuple[dict[str, Any], bytes],
) -> None:
    artifacts = require_object(report.get("sourceArtifacts"), "sourceArtifacts")
    require_equal(set(artifacts), {"plan", "policy", "evidence", "phase7"}, "sourceArtifacts names")
    inputs = {
        "plan": plan_artifact,
        "policy": policy_artifact,
        "evidence": evidence_artifact,
        "phase7": phase7_artifact,
    }
    for name, (_, raw) in inputs.items():
        item = require_object(artifacts.get(name), f"sourceArtifacts.{name}")
        require_equal(set(item), {"sha256"}, f"sourceArtifacts.{name} fields")
        digest = hashlib.sha256(raw).hexdigest()
        require_equal(item.get("sha256"), digest, f"sourceArtifacts.{name}.sha256")

    plan = plan_artifact[0]
    policy = policy_artifact[0]
    evidence = evidence_artifact[0]
    require_equal(plan.get("schemaVersion"), PLAN_SCHEMA, "source plan schemaVersion")
    require_equal(plan.get("planId"), report.get("planId"), "source planId")
    require_equal(plan.get("stages"), PLAN_STAGES, "source plan stages")
    safety = require_object(plan.get("safety"), "source plan safety")
    for name in (
        "requireApprovedPhase7Report",
        "requireDistinctConsumerGroups",
        "requireDistinctOutputPrefixes",
        "requireDistinctCheckpoints",
        "requireExplicitPromotionApproval",
        "requireRollbackReadiness",
    ):
        require_equal(safety.get(name), True, f"source plan safety.{name}")
    require_equal(safety.get("allowAutomaticPromotion"), False, "source plan safety.allowAutomaticPromotion")
    require_equal(plan.get("defaultRuntime"), {"sparkRuntime": DEFAULT_SPARK_RUNTIME, "kafkaRuntime": DEFAULT_KAFKA_RUNTIME}, "source plan defaultRuntime")

    require_equal(policy.get("schemaVersion"), POLICY_SCHEMA, "source policy schemaVersion")
    require_equal(policy.get("policyId"), report.get("policyId"), "source policyId")
    require_equal(policy.get("approvalStatus"), "approved", "source policy approvalStatus")
    report_environment = require_object(report.get("evidenceEnvironment"), "report evidenceEnvironment")
    require_equal(policy.get("evidenceEnvironment"), report_environment.get("name"), "source policy evidenceEnvironment")
    policy_target = require_object(policy.get("target"), "source policy target")
    for name in ("appEnvironment", "storageEnvironment", "region", "sparkRuntime", "kafkaRuntime"):
        normalized = require_text(policy_target.get(name), f"source policy target.{name}")
        if name in {"sparkRuntime", "kafkaRuntime"}:
            normalized = normalized.lower()
        require_equal(normalized, report.get("target", {}).get(name), f"source policy target.{name}")
    approval = require_object(report.get("approval"), "report approval")
    require_equal(policy.get("approvedBy"), approval.get("approvedBy"), "source policy approvedBy")
    require_equal(iso_datetime(policy.get("approvedAt"), "source policy approvedAt"), iso_datetime(approval.get("approvedAt"), "report approval approvedAt"), "source policy approvedAt")
    require_equal(policy.get("changeTicket"), approval.get("changeTicket"), "source policy changeTicket")
    criteria = require_object(report.get("criteria"), "report criteria")
    require_equal(policy.get("minimumShadowRuns"), criteria.get("minimumShadowRuns"), "source policy minimumShadowRuns")
    require_equal(policy.get("minimumObservationMinutes"), criteria.get("minimumObservationMinutes"), "source policy minimumObservationMinutes")
    require_equal(policy.get("thresholds"), criteria.get("thresholds"), "source policy thresholds")
    for name in ("requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"):
        require_equal(policy.get(name), True, f"source policy {name}")
        require_equal(policy.get(name), criteria.get(name), f"source policy/report {name}")

    require_equal(evidence.get("schemaVersion"), EVIDENCE_SCHEMA, "source evidence schemaVersion")
    require_equal(evidence.get("exampleOnly"), False, "source evidence exampleOnly")
    require_equal(evidence.get("campaignId"), report.get("campaignId"), "source evidence campaignId")
    source_environment = require_object(evidence.get("environment"), "source evidence environment")
    environment = {
        "name": require_text(source_environment.get("name"), "source evidence environment.name"),
        "region": require_text(source_environment.get("region"), "source evidence environment.region"),
        "sourceRevision": require_text(source_environment.get("sourceRevision"), "source evidence environment.sourceRevision").lower(),
    }
    if not REVISION_RE.fullmatch(environment["sourceRevision"]):
        fail("source evidence environment.sourceRevision must be a full commit SHA")
    for name in ("name", "region", "sourceRevision"):
        require_equal(environment.get(name), report_environment.get(name), f"source evidence environment.{name}")
    require_equal(environment.get("sourceRevision"), report.get("target", {}).get("sourceRevision"), "source evidence revision")
    require_equal(environment.get("region"), report.get("target", {}).get("region"), "source evidence target region")

    for side in ("baseline", "candidate"):
        source_identity = validate_runtime_identity(evidence.get(side), f"source evidence {side}")
        report_identity = validate_runtime_identity(report.get(side), f"report {side}")
        require_equal(source_identity, report_identity, f"source evidence/report {side}")

    source_stages = require_object(evidence.get("stageEvidence"), "source evidence stageEvidence")
    report_stages = require_object(report.get("stageEvidence"), "report stageEvidence")
    require_equal(set(source_stages), REQUIRED_STAGE_EVIDENCE, "source evidence stage names")
    for stage in REQUIRED_STAGE_EVIDENCE:
        source_item = require_object(source_stages.get(stage), f"source evidence stageEvidence.{stage}")
        report_item = require_object(report_stages.get(stage), f"report stageEvidence.{stage}")
        require_equal(source_item.get("status"), report_item.get("status"), f"source evidence stageEvidence.{stage}.status")
        require_equal(iso_datetime(source_item.get("completedAt"), f"source evidence stageEvidence.{stage}.completedAt"), iso_datetime(report_item.get("completedAt"), f"report stageEvidence.{stage}.completedAt"), f"source evidence stageEvidence.{stage}.completedAt")
        source_stage_digest = require_text(source_item.get("evidenceSha256"), f"source evidence stageEvidence.{stage}.evidenceSha256").lower()
        if not SHA256_RE.fullmatch(source_stage_digest):
            fail(f"source evidence stageEvidence.{stage}.evidenceSha256 must be a SHA-256 digest")
        require_equal(source_stage_digest, report_item.get("evidenceSha256"), f"source evidence stageEvidence.{stage}.evidenceSha256")
        require_equal(normalize_object_storage_uri(source_item.get("artifactRef"), f"source evidence stageEvidence.{stage}.artifactRef"), normalize_object_storage_uri(report_item.get("artifactRef"), f"report stageEvidence.{stage}.artifactRef"), f"source evidence stageEvidence.{stage}.artifactRef")

    expected_summary = summarize_source_shadow_runs(evidence.get("shadowRuns"))
    require_equal(report.get("shadowSummary"), expected_summary, "source evidence derived shadowSummary")
    validate_source_observation(evidence.get("observation"), report.get("observation"))
    validate_source_rollback(evidence.get("rollback"), report.get("rollback"))
    source_escalation = require_object(evidence.get("escalation"), "source evidence escalation")
    normalized_escalation = {
        "owner": require_text(source_escalation.get("owner"), "source evidence escalation.owner"),
        "channel": require_text(source_escalation.get("channel"), "source evidence escalation.channel"),
    }
    require_equal(normalized_escalation, report.get("escalation"), "source evidence escalation")

    input_fingerprint = require_text(require_object(require_source_runs(evidence.get("shadowRuns"))[0], "source evidence shadowRuns[0]").get("inputFingerprint"), "source evidence shadowRuns[0].inputFingerprint").lower()
    fingerprint_value = {
        "environment": environment,
        "baseline": validate_runtime_identity(evidence.get("baseline"), "source evidence baseline"),
        "candidate": validate_runtime_identity(evidence.get("candidate"), "source evidence candidate"),
        "inputFingerprint": input_fingerprint,
    }
    canonical = json.dumps(fingerprint_value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    require_equal(report.get("configurationFingerprint"), hashlib.sha256(canonical.encode("utf-8")).hexdigest(), "source evidence configurationFingerprint")


def require_source_runs(value: Any) -> list[Any]:
    if not isinstance(value, list) or not value:
        fail("source evidence shadowRuns must be a non-empty list")
    return value


def summarize_source_shadow_runs(value: Any) -> dict[str, int]:
    runs = require_source_runs(value)
    seen_ids: set[str] = set()
    stored_deltas: list[int] = []
    quarantine_deltas: list[int] = []
    integrity_failures = 0
    schema_mismatches = 0
    value_mismatches = 0
    quarantine_mismatches = 0
    input_fingerprints: set[str] = set()
    for index, run_value in enumerate(runs):
        run = require_object(run_value, f"source evidence shadowRuns[{index}]")
        run_id = require_text(run.get("runId"), f"source evidence shadowRuns[{index}].runId")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
            fail(f"source evidence shadowRuns[{index}].runId must be a safe identifier")
        if run_id in seen_ids:
            fail("source evidence shadow run IDs must be unique")
        seen_ids.add(run_id)
        produced = int(require_number(run.get("producedCount"), f"source evidence shadowRuns[{index}].producedCount", integer=True))
        input_fingerprint = require_text(run.get("inputFingerprint"), f"source evidence shadowRuns[{index}].inputFingerprint").lower()
        if not SHA256_RE.fullmatch(input_fingerprint):
            fail(f"source evidence shadowRuns[{index}].inputFingerprint must be a SHA-256 digest")
        input_fingerprints.add(input_fingerprint)
        sides: dict[str, dict[str, Any]] = {}
        for side in ("baseline", "candidate"):
            result = dict(require_object(run.get(side), f"source evidence shadowRuns[{index}].{side}"))
            for field in ("consumedCount", "storedCount", "quarantinedCount", "replayedCount", "missingCount", "unexplainedDuplicateCount"):
                require_number(result.get(field), f"source evidence shadowRuns[{index}].{side}.{field}", integer=True)
            for field in ("schemaFingerprint", "valueChecksum", "quarantineChecksum"):
                result[field] = require_text(result.get(field), f"source evidence shadowRuns[{index}].{side}.{field}").lower()
                if not SHA256_RE.fullmatch(result[field]):
                    fail(f"source evidence shadowRuns[{index}].{side}.{field} must be a SHA-256 digest")
            reconciled = result["storedCount"] + result["quarantinedCount"] - result["replayedCount"]
            if result["consumedCount"] != produced or reconciled != result["consumedCount"] or result["missingCount"] != 0 or result["unexplainedDuplicateCount"] != 0:
                integrity_failures += 1
            sides[side] = result
        stored_deltas.append(abs(sides["baseline"]["storedCount"] - sides["candidate"]["storedCount"]))
        quarantine_deltas.append(abs(sides["baseline"]["quarantinedCount"] - sides["candidate"]["quarantinedCount"]))
        schema_mismatches += sides["baseline"]["schemaFingerprint"] != sides["candidate"]["schemaFingerprint"]
        value_mismatches += sides["baseline"]["valueChecksum"] != sides["candidate"]["valueChecksum"]
        quarantine_mismatches += sides["baseline"]["quarantineChecksum"] != sides["candidate"]["quarantineChecksum"]
    if len(input_fingerprints) != 1:
        fail("source evidence shadow runs must use one comparable input fingerprint")
    return {
        "runCount": len(runs),
        "integrityFailureSides": integrity_failures,
        "maxStoredCountDelta": max(stored_deltas),
        "maxQuarantineCountDelta": max(quarantine_deltas),
        "schemaMismatchRuns": schema_mismatches,
        "valueMismatchRuns": value_mismatches,
        "quarantineMismatchRuns": quarantine_mismatches,
    }


def validate_source_observation(source_value: Any, report_value: Any) -> None:
    source = require_object(source_value, "source evidence observation")
    report = require_object(report_value, "report observation")
    started = iso_datetime(source.get("startedAt"), "source evidence observation.startedAt")
    completed = iso_datetime(source.get("completedAt"), "source evidence observation.completedAt")
    if completed < started:
        fail("source evidence observation completedAt precedes startedAt")
    total = int(require_number(source.get("totalRuns"), "source evidence observation.totalRuns", integer=True))
    failed = int(require_number(source.get("failedRuns"), "source evidence observation.failedRuns", integer=True))
    if failed > total or total == 0:
        fail("source evidence observation requires positive totalRuns and failedRuns <= totalRuns")
    require_equal(iso_datetime(report.get("startedAt"), "report observation.startedAt"), started, "source evidence observation.startedAt")
    require_equal(iso_datetime(report.get("completedAt"), "report observation.completedAt"), completed, "source evidence observation.completedAt")
    require_equal(report.get("durationMinutes"), round((completed - started).total_seconds() / 60, 3), "source evidence observation.durationMinutes")
    require_equal(report.get("totalRuns"), total, "source evidence observation.totalRuns")
    require_equal(report.get("failedRuns"), failed, "source evidence observation.failedRuns")
    require_equal(report.get("errorRate"), round(failed / total, 6), "source evidence observation.errorRate")
    for metric in ("maxLag", "p95LatencyMs", "costUsd"):
        require_equal(report.get(metric), source.get(metric), f"source evidence observation.{metric}")


def validate_source_rollback(source_value: Any, report_value: Any) -> None:
    source = require_object(source_value, "source evidence rollback")
    report = require_object(report_value, "report rollback")
    for name in ("sparkRuntime", "kafkaRuntime"):
        require_equal(require_text(source.get(name), f"source evidence rollback.{name}").lower(), report.get(name), f"source evidence rollback.{name}")
    require_equal(require_text(source.get("previousGoodRevision"), "source evidence rollback.previousGoodRevision").lower(), report.get("previousGoodRevision"), "source evidence rollback.previousGoodRevision")
    for name in ("owner", "runbookRef"):
        require_equal(require_text(source.get(name), f"source evidence rollback.{name}"), report.get(name), f"source evidence rollback.{name}")
    require_equal(iso_datetime(source.get("lastTestedAt"), "source evidence rollback.lastTestedAt"), iso_datetime(report.get("lastTestedAt"), "report rollback.lastTestedAt"), "source evidence rollback.lastTestedAt")


def validate_chronology(report: dict[str, Any], phase7: dict[str, Any]) -> None:
    stages = require_object(report.get("stageEvidence"), "stageEvidence")
    stage_times = [iso_datetime(stages[stage].get("completedAt"), f"stageEvidence.{stage}.completedAt") for stage in ("docker-regression", "aws-batch-staging", "aws-continuous-staging", "small-workload-cutover")]
    phase7_approved = iso_datetime(phase7.get("profile", {}).get("approvedAt"), "Phase 7 profile approvedAt")
    observation = require_object(report.get("observation"), "observation")
    observation_started = iso_datetime(observation.get("startedAt"), "observation.startedAt")
    observation_completed = iso_datetime(observation.get("completedAt"), "observation.completedAt")
    approval_time = iso_datetime(report.get("approval", {}).get("approvedAt"), "cutover approval approvedAt")
    rollback_time = iso_datetime(report.get("rollback", {}).get("lastTestedAt"), "rollback lastTestedAt")
    generated_time = iso_datetime(report.get("generatedAt"), "cutover generatedAt")
    if phase7_approved > stage_times[0]:
        fail("Phase 7 approval must precede Phase 8 execution")
    if any(left > right for left, right in zip(stage_times, stage_times[1:])):
        fail("Phase 8 explicit stage timestamps are out of order")
    if stage_times[-1] > observation_started or observation_started > observation_completed:
        fail("observation must follow the small-workload stage")
    if observation_completed > approval_time:
        fail("promotion approval must follow observation completion")
    if rollback_time > approval_time:
        fail("rollback test must precede promotion approval")
    evidence_times = [phase7_approved, *stage_times, observation_started, observation_completed, rollback_time, approval_time]
    if any(value > generated_time for value in evidence_times):
        fail("evidence and approval timestamps must not be in the future relative to report generation")


def validate_repository_rollback(report: dict[str, Any], root: Path, current_revision: str) -> None:
    rollback = require_object(report.get("rollback"), "rollback")
    previous_revision = str(rollback.get("previousGoodRevision") or "")
    try:
        subprocess.run(["git", "cat-file", "-e", f"{previous_revision}^{{commit}}"], cwd=root, check=True, capture_output=True)
        subprocess.run(["git", "merge-base", "--is-ancestor", previous_revision, current_revision], cwd=root, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"rollback previousGoodRevision must exist and be an ancestor of the deployed revision: {error}")
    runbook_ref = require_text(rollback.get("runbookRef"), "rollback runbookRef")
    runbook_path = (root / runbook_ref.split("#", 1)[0]).resolve()
    try:
        runbook_path.relative_to(root)
    except ValueError:
        fail("rollback runbookRef resolves outside the repository")
    if not runbook_path.is_file():
        fail(f"rollback runbook does not exist: {runbook_ref}")


def main() -> int:
    args = parse_args()
    try:
        if not args.env_file.is_absolute() or not args.repository_root.is_absolute():
            fail("deployment env file and repository root paths must be absolute")
        env = load_env(args.env_file.resolve())
        spark_runtime = env.get("ASKLAKE_SPARK_RUNTIME", DEFAULT_SPARK_RUNTIME).strip().lower()
        kafka_runtime = env.get("ASKLAKE_KAFKA_RUNTIME", DEFAULT_KAFKA_RUNTIME).strip().lower()
        if env.get("APP_ENV") != "production":
            fail("Runtime promotion gate is only valid for APP_ENV=production")
        if spark_runtime == DEFAULT_SPARK_RUNTIME and kafka_runtime == DEFAULT_KAFKA_RUNTIME:
            print("Runtime promotion gate skipped for the default rollback Runtime pair")
            return 0
        for label, path in (
            ("cutover report", args.report),
            ("cutover plan", args.plan),
            ("cutover policy", args.policy),
            ("cutover evidence", args.evidence),
            ("Phase 7 report", args.phase7_report),
        ):
            if not path.is_absolute():
                fail(f"{label} path must be absolute: {path}")
        report, _ = load_json(args.report.resolve(), "cutover report")
        plan_artifact = load_json(args.plan.resolve(), "cutover plan")
        policy_artifact = load_json(args.policy.resolve(), "cutover policy")
        evidence_artifact = load_json(args.evidence.resolve(), "cutover evidence")
        phase7, phase7_raw = load_json(args.phase7_report.resolve(), "Phase 7 report")
        repository_root = args.repository_root.resolve()
        revision = repository_revision(repository_root)
        validate_cutover(report, env, revision)
        embedded_phase7 = report.get("phase7Report")
        if not isinstance(embedded_phase7, dict):
            fail("cutover report phase7Report must be an object")
        validate_phase7(phase7, phase7_raw, embedded_phase7)
        validate_source_artifacts(report, plan_artifact, policy_artifact, evidence_artifact, (phase7, phase7_raw))
        validate_chronology(report, phase7)
        validate_repository_rollback(report, repository_root, revision)
    except ValueError as error:
        print(f"error: Runtime promotion gate rejected deployment: {error}", file=sys.stderr)
        return 1
    print("Runtime promotion gate passed for the exact approved report and deployed revision")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
