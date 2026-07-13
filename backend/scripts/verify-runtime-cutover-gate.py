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
    "row-count-delta",
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
}
REQUIRED_STAGE_EVIDENCE = {
    "docker-regression",
    "aws-batch-staging",
    "aws-continuous-staging",
    "small-workload-cutover",
}
THRESHOLD_NAMES = {
    "maxRowCountDelta",
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
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
        if require_number(scenario.get("runCount"), f"Phase 7 scenario {scenario_id} runCount", integer=True) < minimum_runs:
            fail(f"Phase 7 scenario {scenario_id} is below the approved repeat count")
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
    require_equal(embedded.get("approvedAt"), approved_at, "embedded Phase 7 approvedAt")


def validate_runtime_identity(value: Any, label: str) -> dict[str, Any]:
    identity = require_object(value, label)
    for key in ("sparkRuntime", "kafkaRuntime", "topic", "consumerGroup", "outputPrefix", "checkpointPath"):
        require_text(identity.get(key), f"{label}.{key}")
    for key in ("outputPrefix", "checkpointPath"):
        if not re.fullmatch(r"s3a?://[^/?#]+/.+", identity[key]):
            fail(f"{label}.{key} must be an S3/S3A prefix")
    return identity


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

    criteria = require_object(report.get("criteria"), "criteria")
    minimum_runs = require_number(criteria.get("minimumShadowRuns"), "criteria.minimumShadowRuns", integer=True)
    minimum_minutes = require_number(criteria.get("minimumObservationMinutes"), "criteria.minimumObservationMinutes")
    if minimum_runs <= 0 or minimum_minutes <= 0:
        fail("cutover minimum run and observation criteria must be positive")
    thresholds = require_object(criteria.get("thresholds"), "criteria.thresholds")
    require_equal(set(thresholds), THRESHOLD_NAMES, "criteria threshold names")
    for name, value in thresholds.items():
        require_number(value, f"criteria.thresholds.{name}")
    for name in ("requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"):
        if not isinstance(criteria.get(name), bool):
            fail(f"criteria.{name} must be boolean")

    summary = require_object(report.get("shadowSummary"), "shadowSummary")
    run_count = int(require_number(summary.get("runCount"), "shadowSummary.runCount", integer=True))
    if run_count < minimum_runs:
        fail("shadow run count is below the approved minimum")
    require_equal(summary.get("integrityFailureSides"), 0, "shadow integrityFailureSides")
    if require_number(summary.get("maxRowCountDelta"), "shadowSummary.maxRowCountDelta") > thresholds["maxRowCountDelta"]:
        fail("shadow row count delta exceeds the approved threshold")
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
    if not re.fullmatch(r"(?:docs|scripts)/[^.].*", require_text(rollback.get("runbookRef"), "rollback runbookRef")):
        fail("rollback runbookRef must reference docs/ or scripts/")
    escalation = require_object(report.get("escalation"), "escalation")
    require_text(escalation.get("owner"), "escalation owner")
    require_text(escalation.get("channel"), "escalation channel")


def main() -> int:
    args = parse_args()
    try:
        env = load_env(args.env_file)
        spark_runtime = env.get("ASKLAKE_SPARK_RUNTIME", DEFAULT_SPARK_RUNTIME).strip().lower()
        kafka_runtime = env.get("ASKLAKE_KAFKA_RUNTIME", DEFAULT_KAFKA_RUNTIME).strip().lower()
        if env.get("APP_ENV") != "production":
            fail("Runtime promotion gate is only valid for APP_ENV=production")
        if spark_runtime == DEFAULT_SPARK_RUNTIME and kafka_runtime == DEFAULT_KAFKA_RUNTIME:
            print("Runtime promotion gate skipped for the default rollback Runtime pair")
            return 0
        report, _ = load_json(args.report.resolve(), "cutover report")
        phase7, phase7_raw = load_json(args.phase7_report.resolve(), "Phase 7 report")
        revision = repository_revision(args.repository_root.resolve())
        validate_cutover(report, env, revision)
        embedded_phase7 = report.get("phase7Report")
        if not isinstance(embedded_phase7, dict):
            fail("cutover report phase7Report must be an object")
        validate_phase7(phase7, phase7_raw, embedded_phase7)
    except ValueError as error:
        print(f"error: Runtime promotion gate rejected deployment: {error}", file=sys.stderr)
        return 1
    print("Runtime promotion gate passed for the exact approved report and deployed revision")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
