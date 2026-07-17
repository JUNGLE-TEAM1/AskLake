#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRecordPath,
  collectNodeGroups,
  parseEvents,
  resolveAwsRegion,
  resolveClusterName,
  runJson,
  runText,
} from "./watch-eks-day17-scale.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_NAMESPACE = process.env.ASKLAKE_EKS_NAMESPACE || "asklake-dev";
const DEFAULT_RECORD = "/private/tmp/asklake-day17-multi-spark-observer.jsonl";
const EXPECTED_RUNS = 3;
const DEFAULT_GROUP = "asklake-eks-mvp-spark-v1";
const DEFAULT_TABLE = "eks_mvp_fixture";
const FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1";
const ALIASES = ["A", "B", "C"];
const ACTIVE_RUN_STATES = new Set(["queued", "running"]);
const TERMINAL_POD_PHASES = new Set(["Succeeded", "Failed"]);
const NODE_SCALE_EVENT_REASONS = new Set([
  "Created",
  "Launched",
  "Registered",
  "Initialized",
  "Ready",
  "NodeReady",
  "Scheduled",
]);
const FORBIDDEN_KEYS = new Set([
  "runId",
  "jobId",
  "applicationName",
  "snapshotId",
  "datasetId",
  "consumerGroup",
  "icebergTable",
  "outputPath",
  "checkpointPath",
  "nodeName",
  "ip",
  "endpoint",
  "arn",
]);

export const RDS_QUERY = String.raw`
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from sqlalchemy import func, select
from app.core.database import SessionLocal
from app.models import ETLJobModel, ETLRunModel, KafkaContinuousSessionModel

DEFAULT_GROUP = "asklake-eks-mvp-spark-v1"
DEFAULT_TABLE = "eks_mvp_fixture"
FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1"
ACTIVE = {"queued", "running"}

def short_hash(value):
    normalized = str(value or "").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12] if normalized else None

def run_label(value):
    normalized = re.sub(r"[^a-z0-9-]+", "-", str(value or "").lower())
    normalized = re.sub(r"^-+|-+$", "", normalized)
    normalized = re.sub(r"-+", "-", normalized)
    return (normalized or "run")[:63].rstrip("-") or "run"

def field(fields, names):
    for item in fields or []:
        if isinstance(item, list) and len(item) >= 2 and str(item[0]) in names:
            return str(item[1] or "").strip()
    return ""

def utc_value(value):
    if value is None:
        return None
    if hasattr(value, "tzinfo") and value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    if hasattr(value, "isoformat"):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)

def aware(value):
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

started_at = datetime.fromisoformat(
    os.environ["OBSERVER_STARTED_AT"].replace("Z", "+00:00")
).astimezone(timezone.utc)

raw_slots = str(os.environ.get("ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON") or "").strip()
try:
    slot_payload = json.loads(raw_slots) if raw_slots else [
        {"consumerGroup": DEFAULT_GROUP, "table": DEFAULT_TABLE}
    ]
except Exception:
    slot_payload = []
slot_groups = {
    str(item.get("consumerGroup") or "").strip()
    for item in slot_payload
    if isinstance(item, dict)
}
scale_groups = slot_groups - {DEFAULT_GROUP}

try:
    from scripts.kafka_fixture_slots import load_eks_fixture_slots
    load_eks_fixture_slots()
    multi_slot_runtime_support = True
except Exception:
    multi_slot_runtime_support = False

db = SessionLocal()
try:
    jobs = db.scalars(select(ETLJobModel)).all()
    fixture_job_groups = []
    scale_job_groups = []
    jobs_by_id = {}
    for job in jobs:
        jobs_by_id[str(job.id)] = job
        fields = job.source_config or []
        group = field(fields, {"CONSUMER GROUP ID", "Consumer Group ID"})
        topic = field(fields, {"TOPIC / QUEUE NAME", "Topic", "topic"})
        batch = field(fields, {"__EKS MVP Fixture Batch ID"})
        count = field(fields, {"__EKS MVP Expected Count"})
        if topic == FIXTURE_TOPIC and group and batch and count == "100":
            fixture_job_groups.append(group)
            if group in scale_groups:
                scale_job_groups.append(group)

    observed_runs = []
    runs = db.scalars(
        select(ETLRunModel).order_by(ETLRunModel.created_at.desc()).limit(100)
    ).all()
    for run in runs:
        states = run.task_states or {}
        fixture = states.get("eksMvpFixture") if isinstance(states, dict) else None
        boundary = fixture.get("sourceBoundary") if isinstance(fixture, dict) else None
        if not isinstance(boundary, dict):
            continue
        if boundary.get("kind") != "kafka_snapshot" or boundary.get("topic") != FIXTURE_TOPIC:
            continue
        created_at = aware(run.created_at)
        if str(run.status or "") not in ACTIVE and (
            created_at is None or created_at < started_at
        ):
            continue

        job = jobs_by_id.get(str(run.job_id))
        spark_execution = states.get("sparkExecution") if isinstance(states, dict) else {}
        spark_result = states.get("sparkResult") if isinstance(states, dict) else {}
        catalog_result = states.get("catalogResult") if isinstance(states, dict) else {}
        spark_execution = spark_execution if isinstance(spark_execution, dict) else {}
        spark_result = spark_result if isinstance(spark_result, dict) else {}
        catalog_result = catalog_result if isinstance(catalog_result, dict) else {}
        kubernetes_execution = (
            spark_result.get("kubernetesExecution")
            or spark_execution.get("kubernetesExecution")
            or {}
        )
        commit = spark_result.get("icebergCommit") or {}
        run_id = str(run.run_id)
        observed_runs.append({
            "createdAt": utc_value(run.created_at),
            "runHash": short_hash(run_id),
            "runLabelHash": short_hash(run_label(run_id)),
            "jobHash": short_hash(run.job_id),
            "rds": str(run.status or "unknown"),
            "airflow": str(run.airflow_state or "waiting"),
            "spark": str(
                spark_result.get("status")
                or spark_execution.get("status")
                or "waiting"
            ),
            "catalog": str(catalog_result.get("status") or "waiting"),
            "generation": int(run.execution_generation or 0),
            "uidHash": short_hash(kubernetes_execution.get("applicationUid")),
            "snapshotHash": short_hash(commit.get("snapshotId")),
            "datasetHash": short_hash(job.dataset_id if job is not None else None),
            "groupHash": short_hash(boundary.get("consumerGroup")),
            "tableHash": short_hash(
                fixture.get("icebergTable") if isinstance(fixture, dict) else None
            ),
            "outputHash": short_hash(boundary.get("outputPath")),
            "checkpointHash": short_hash(boundary.get("checkpointPath")),
        })

    observed_runs.sort(key=lambda item: item.get("createdAt") or "")
    continuous_since_start = int(db.scalar(
        select(func.count())
        .select_from(KafkaContinuousSessionModel)
        .where(KafkaContinuousSessionModel.created_at >= started_at)
    ) or 0)
    print(json.dumps({
        "multiSlotRuntimeSupport": multi_slot_runtime_support,
        "fixtureJobs": len(fixture_job_groups),
        "candidateScaleJobs": len(scale_job_groups),
        "candidateDistinctScaleSlots": len(set(scale_job_groups)),
        "continuousSessionsStarted": continuous_since_start,
        "runs": observed_runs,
    }, separators=(",", ":")))
finally:
    db.close()
`;

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeState(value, fallback = "waiting") {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_.-]{1,32}$/.test(normalized) ? normalized : fallback;
}

function hashOrNull(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{12}$/.test(normalized) ? normalized : null;
}

export function shortHash(value) {
  const normalized = String(value || "").trim();
  return normalized
    ? createHash("sha256").update(normalized).digest("hex").slice(0, 12)
    : null;
}

export function parseScaleSlotConfig(document) {
  const raw = document?.data?.ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON;
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      status: "available",
      configured: false,
      valid: true,
      totalSlots: 1,
      scaleSlots: 0,
      uniqueConsumerGroups: true,
      uniqueTables: true,
      defaultPreserved: true,
    };
  }
  try {
    const slots = JSON.parse(raw);
    if (!Array.isArray(slots)) throw new Error("not-array");
    const shaped = slots.every(
      (slot) =>
        slot &&
        typeof slot === "object" &&
        Object.keys(slot).sort().join(",") === "consumerGroup,table" &&
        typeof slot.consumerGroup === "string" &&
        typeof slot.table === "string",
    );
    const groups = shaped ? slots.map((slot) => slot.consumerGroup.trim()) : [];
    const tables = shaped ? slots.map((slot) => slot.table.trim()) : [];
    const uniqueConsumerGroups = new Set(groups).size === slots.length;
    const uniqueTables = new Set(tables).size === slots.length;
    const defaultPreserved = shaped && slots.some(
      (slot) =>
        slot.consumerGroup.trim() === DEFAULT_GROUP &&
        slot.table.trim() === DEFAULT_TABLE,
    );
    const valid =
      shaped &&
      slots.length >= 1 &&
      slots.length <= 5 &&
      uniqueConsumerGroups &&
      uniqueTables &&
      defaultPreserved;
    return {
      status: valid ? "available" : "invalid",
      configured: valid && slots.length > 1,
      valid,
      totalSlots: valid ? slots.length : 0,
      scaleSlots: valid ? Math.max(0, slots.length - 1) : 0,
      uniqueConsumerGroups,
      uniqueTables,
      defaultPreserved,
    };
  } catch {
    return {
      status: "invalid",
      configured: false,
      valid: false,
      totalSlots: 0,
      scaleSlots: 0,
      uniqueConsumerGroups: false,
      uniqueTables: false,
      defaultPreserved: false,
    };
  }
}

export function parseRdsPayload(document) {
  if (!document || typeof document !== "object" || !Array.isArray(document.runs)) {
    return { status: "unavailable", error: "read command failed", runs: [] };
  }
  const runs = document.runs.map((run) => ({
    createdAt:
      typeof run.createdAt === "string" && Number.isFinite(Date.parse(run.createdAt))
        ? new Date(run.createdAt).toISOString()
        : null,
    runHash: hashOrNull(run.runHash),
    runLabelHash: hashOrNull(run.runLabelHash),
    jobHash: hashOrNull(run.jobHash),
    rds: safeState(run.rds, "unknown"),
    airflow: safeState(run.airflow),
    spark: safeState(run.spark),
    catalog: safeState(run.catalog),
    generation: Math.max(0, Math.trunc(numberOr(run.generation))),
    uidHash: hashOrNull(run.uidHash),
    snapshotHash: hashOrNull(run.snapshotHash),
    datasetHash: hashOrNull(run.datasetHash),
    groupHash: hashOrNull(run.groupHash),
    tableHash: hashOrNull(run.tableHash),
    outputHash: hashOrNull(run.outputHash),
    checkpointHash: hashOrNull(run.checkpointHash),
  })).filter((run) => run.runHash && run.runLabelHash);
  return {
    status: "available",
    multiSlotRuntimeSupport: document.multiSlotRuntimeSupport === true,
    fixtureJobs: Math.max(0, Math.trunc(numberOr(document.fixtureJobs))),
    candidateScaleJobs: Math.max(0, Math.trunc(numberOr(document.candidateScaleJobs))),
    candidateDistinctScaleSlots: Math.max(
      0,
      Math.trunc(numberOr(document.candidateDistinctScaleSlots)),
    ),
    continuousSessionsStarted: Math.max(
      0,
      Math.trunc(numberOr(document.continuousSessionsStarted)),
    ),
    runs,
  };
}

function applicationBucket(state) {
  const normalized = String(state || "").trim().toUpperCase();
  if (["COMPLETED", "FAILED"].includes(normalized)) return "Completed";
  if (["RUNNING", "SUCCEEDING", "FAILING"].includes(normalized)) return "Running";
  return "Pending";
}

export function parseSparkApplications(document) {
  const items = [];
  const counts = { Pending: 0, Running: 0, Completed: 0 };
  for (const application of document?.items || []) {
    const annotations = application.metadata?.annotations || {};
    const state = applicationBucket(
      application.status?.applicationState?.state,
    );
    counts[state] += 1;
    items.push({
      runHash: shortHash(annotations["asklake.io/run-id"]),
      uidHash: shortHash(application.metadata?.uid),
      state,
    });
  }
  return { status: "available", total: items.length, counts, items };
}

function sparkRole(pod) {
  const labels = pod.metadata?.labels || {};
  const role = labels["spark-role"] || labels["sparkoperator.k8s.io/role"];
  return role === "driver" || role === "executor" ? role : null;
}

function blankRoleCounts() {
  return {
    driver: { Pending: 0, Running: 0, Completed: 0 },
    executor: { Pending: 0, Running: 0, Completed: 0 },
  };
}

export function parseSparkPods(document) {
  const byRunLabelHash = new Map();
  const totals = blankRoleCounts();
  for (const pod of document?.items || []) {
    const role = sparkRole(pod);
    if (!role) continue;
    const rawLabel = pod.metadata?.labels?.["asklake.io/run-id"];
    const runLabelHash = shortHash(rawLabel);
    if (!runLabelHash) continue;
    const phase = pod.status?.phase;
    const bucket = phase === "Pending"
      ? "Pending"
      : phase === "Running"
        ? "Running"
        : TERMINAL_POD_PHASES.has(phase)
          ? "Completed"
          : "Pending";
    if (!byRunLabelHash.has(runLabelHash)) {
      byRunLabelHash.set(runLabelHash, blankRoleCounts());
    }
    byRunLabelHash.get(runLabelHash)[role][bucket] += 1;
    totals[role][bucket] += 1;
  }
  return { status: "available", totals, byRunLabelHash };
}

export class RunAliasTracker {
  constructor() {
    this.aliasByHash = new Map();
    this.lastByHash = new Map();
  }

  update(runs) {
    const sorted = [...runs].sort((left, right) =>
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    );
    for (const run of sorted) {
      this.lastByHash.set(run.runHash, run);
      if (!this.aliasByHash.has(run.runHash) && this.aliasByHash.size < EXPECTED_RUNS) {
        this.aliasByHash.set(run.runHash, ALIASES[this.aliasByHash.size]);
      }
    }
    return ALIASES.map((alias) => {
      const match = [...this.aliasByHash.entries()].find(([, value]) => value === alias);
      if (!match) return { alias, state: "waiting" };
      const run = this.lastByHash.get(match[0]);
      return run ? { ...run, alias, state: "observed" } : { alias, state: "waiting" };
    });
  }
}

function uniqueField(entries, key) {
  const values = entries.map((entry) => entry[key]).filter(Boolean);
  return {
    present: values.length,
    unique: new Set(values).size,
    expected: EXPECTED_RUNS,
    valid:
      entries.length === EXPECTED_RUNS &&
      values.length === EXPECTED_RUNS &&
      new Set(values).size === EXPECTED_RUNS,
  };
}

export function buildIsolation(entries) {
  const observed = entries.filter((entry) => entry.state === "observed");
  const fields = {
    consumerGroups: uniqueField(observed, "groupHash"),
    icebergTables: uniqueField(observed, "tableHash"),
    outputs: uniqueField(observed, "outputHash"),
    checkpoints: uniqueField(observed, "checkpointHash"),
  };
  return {
    observedRuns: observed.length,
    fields,
    valid: Object.values(fields).every((field) => field.valid),
  };
}

function runningNodeCount(nodes, pool) {
  return (nodes.groups || [])
    .filter((group) => group.pool === pool && group.state === "running")
    .reduce((sum, group) => sum + group.count, 0);
}

export class NodeScaleTracker {
  constructor(startedAt) {
    this.startedAt = Date.parse(startedAt);
    this.baselineSparkNodes = null;
  }

  observe(nodes, events) {
    if (nodes.status !== "available") {
      return { status: "unavailable", baselineSparkNodes: null, sparkNodes: null };
    }
    const sparkNodes = runningNodeCount(nodes, "asklake-spark");
    if (this.baselineSparkNodes == null) this.baselineSparkNodes = sparkNodes;
    const eventSignal = (events.items || []).some(
      (event) =>
        Number.isFinite(Date.parse(event.observedAt)) &&
        Date.parse(event.observedAt) >= this.startedAt &&
        ["Node", "NodeClaim"].includes(event.kind) &&
        NODE_SCALE_EVENT_REASONS.has(event.reason),
    );
    return {
      status:
        sparkNodes > this.baselineSparkNodes || eventSignal ? "observable" : "waiting",
      baselineSparkNodes: this.baselineSparkNodes,
      sparkNodes,
      increased: sparkNodes > this.baselineSparkNodes,
      eventSignal,
    };
  }
}

export function assertSanitizedSnapshot(snapshot) {
  const inspect = (value, path = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new Error(`unsanitized key at ${[...path, key].join(".")}`);
        }
        inspect(child, [...path, key]);
      }
      return;
    }
    if (typeof value !== "string") return;
    if (
      /arn:aws|https?:\/\/|s3a?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(value)
    ) {
      throw new Error(`unsanitized identifier at ${path.join(".")}`);
    }
  };
  inspect(snapshot);
  return snapshot;
}

async function collectRds(namespace, startedAt) {
  const result = await runText(
    "kubectl",
    [
      "exec",
      "-n",
      namespace,
      "deployment/fastapi",
      "--",
      "env",
      `OBSERVER_STARTED_AT=${startedAt}`,
      "python",
      "-c",
      RDS_QUERY,
    ],
    20_000,
  );
  if (!result.ok) {
    return { status: "unavailable", error: result.error, runs: [] };
  }
  try {
    return parseRdsPayload(JSON.parse(result.value));
  } catch {
    return { status: "unavailable", error: "read command failed", runs: [] };
  }
}

function publicPods(parsedPods, entries) {
  if (parsedPods.status !== "available") return parsedPods;
  return {
    status: "available",
    totals: parsedPods.totals,
    runs: entries.map((entry) => ({
      alias: entry.alias,
      counts:
        entry.state === "observed"
          ? parsedPods.byRunLabelHash.get(entry.runLabelHash) || blankRoleCounts()
          : blankRoleCounts(),
    })),
  };
}

function publicApplications(parsedApplications, entries) {
  if (parsedApplications.status !== "available") return parsedApplications;
  const observedHashes = new Set(
    entries.filter((entry) => entry.state === "observed").map((entry) => entry.runHash),
  );
  const relevant = parsedApplications.items.filter((item) =>
    observedHashes.has(item.runHash),
  );
  return {
    status: "available",
    total: parsedApplications.total,
    counts: parsedApplications.counts,
    runs: entries.map((entry) => {
      const application = relevant.find((item) => item.runHash === entry.runHash);
      return {
        alias: entry.alias,
        state: application?.state || "waiting",
        uidHash: application?.uidHash || null,
      };
    }),
  };
}

function buildGates(rds, entries, applications, isolation, nodeScale) {
  const activeRuns = entries.filter(
    (entry) => entry.state === "observed" && ACTIVE_RUN_STATES.has(entry.rds),
  ).length;
  const liveUids =
    applications.status === "available"
      ? applications.runs.map((run) => run.uidHash).filter(Boolean)
      : [];
  return {
    threeRunsActive:
      rds.status === "available"
        ? activeRuns === EXPECTED_RUNS ? "ready" : `waiting-${activeRuns}/${EXPECTED_RUNS}`
        : "unavailable",
    applicationUidsUnique:
      applications.status !== "available"
        ? "unavailable"
        : liveUids.length === EXPECTED_RUNS && new Set(liveUids).size === EXPECTED_RUNS
          ? "ready"
          : `waiting-${new Set(liveUids).size}/${EXPECTED_RUNS}`,
    isolation: isolation.valid ? "ready" : `waiting-${isolation.observedRuns}/${EXPECTED_RUNS}`,
    continuous:
      rds.status === "available"
        ? rds.continuousSessionsStarted === 0 ? "ready-0" : `failed-${rds.continuousSessionsStarted}`
        : "unavailable",
    nodeScale: nodeScale.status,
  };
}

function buildBlockers(runtimeConfig, rds, applications, nodes) {
  const blockers = [];
  if (
    runtimeConfig.status !== "available" ||
    !runtimeConfig.valid ||
    runtimeConfig.scaleSlots < EXPECTED_RUNS
  ) {
    blockers.push("scale slots not configured");
  }
  if (rds.status !== "available" || rds.candidateDistinctScaleSlots < EXPECTED_RUNS) {
    blockers.push("candidate jobs missing");
  }
  if (rds.status === "available" && !rds.multiSlotRuntimeSupport) {
    blockers.push("Backend multi-slot runtime unavailable");
  }
  if (applications.status !== "available") {
    blockers.push("SparkApplication RBAC unavailable");
  }
  if (nodes.status !== "available") {
    blockers.push("Node visibility unavailable");
  }
  if (rds.status !== "available") blockers.push("RDS visibility unavailable");
  return blockers;
}

async function collectSnapshot(
  options,
  startedAt,
  aliasTracker,
  nodeScaleTracker,
  clusterNameResult,
  regionResult,
) {
  const [
    configResult,
    applicationsResult,
    podsResult,
    eventsResult,
    nodes,
    rds,
  ] = await Promise.all([
    runJson("kubectl", [
      "get",
      "configmap",
      "asklake-runtime",
      "-n",
      options.namespace,
      "-o",
      "json",
    ]),
    runJson("kubectl", [
      "get",
      "sparkapplications.sparkoperator.k8s.io",
      "-n",
      options.namespace,
      "-o",
      "json",
    ]),
    runJson("kubectl", ["get", "pods", "-n", options.namespace, "-o", "json"]),
    runJson("kubectl", ["get", "events", "-A", "-o", "json"]),
    collectNodeGroups(clusterNameResult, regionResult),
    collectRds(options.namespace, startedAt),
  ]);

  const runtimeConfig = configResult.ok
    ? parseScaleSlotConfig(configResult.value)
    : { status: "unavailable", error: configResult.error, valid: false, scaleSlots: 0 };
  const parsedApplications = applicationsResult.ok
    ? parseSparkApplications(applicationsResult.value)
    : { status: "unavailable", error: applicationsResult.error, total: 0, counts: {} };
  const parsedPods = podsResult.ok
    ? parseSparkPods(podsResult.value)
    : { status: "unavailable", error: podsResult.error };
  const events = eventsResult.ok
    ? { status: "available", items: parseEvents(eventsResult.value) }
    : { status: "unavailable", error: eventsResult.error, items: [] };
  const entries = aliasTracker.update(rds.runs || []);
  const applications = publicApplications(parsedApplications, entries);
  const pods = publicPods(parsedPods, entries);
  const isolation = buildIsolation(entries);
  const nodeScale = nodeScaleTracker.observe(nodes, events);
  const gates = buildGates(rds, entries, applications, isolation, nodeScale);
  const blockers = buildBlockers(runtimeConfig, rds, applications, nodes);
  const errors = [
    runtimeConfig.status !== "available" ? `Runtime Config: ${runtimeConfig.error || runtimeConfig.status}` : null,
    rds.status !== "available" ? `RDS: ${rds.error}` : null,
    applications.status !== "available" ? `SparkApplication: ${applications.error}` : null,
    pods.status !== "available" ? `Pods: ${pods.error}` : null,
    nodes.status !== "available" ? `Nodes: ${nodes.error}` : null,
    events.status !== "available" ? `Events: ${events.error}` : null,
  ].filter(Boolean);

  return assertSanitizedSnapshot({
    contractVersion: "1.0",
    observedAt: new Date().toISOString(),
    observerStartedAt: startedAt,
    mode: "read-only",
    runtimeConfig,
    setup: {
      candidateScaleJobs:
        rds.status === "available" ? rds.candidateScaleJobs : null,
      candidateDistinctScaleSlots:
        rds.status === "available" ? rds.candidateDistinctScaleSlots : null,
      multiSlotRuntimeSupport:
        rds.status === "available" ? rds.multiSlotRuntimeSupport : null,
    },
    runs: {
      status: rds.status,
      entries,
      continuousSessionsStarted:
        rds.status === "available" ? rds.continuousSessionsStarted : null,
    },
    sparkApplications: applications,
    pods,
    isolation,
    nodes,
    nodeScale,
    events,
    gates,
    blockers,
    errors,
  });
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function roleText(role) {
  return `P${role.Pending}/R${role.Running}/C${role.Completed}`;
}

export function renderDashboard(snapshot, options) {
  const lines = [
    "AskLake Day 17 Multi-Spark Observer  [READ-ONLY]",
    `${formatClock(snapshot.observedAt)} KST · ${options.interval}s refresh · Ctrl-C 종료 · sanitized JSONL 0600`,
    "─".repeat(96),
    "RUNS     RDS / Airflow / Spark / Catalog / generation (identifiers hidden)",
  ];
  for (const run of snapshot.runs.entries) {
    if (run.state !== "observed") {
      lines.push(`         Run ${run.alias}  waiting for observed fixture Run`);
      continue;
    }
    lines.push(
      `         Run ${run.alias} #${run.runHash.slice(0, 8)}  RDS ${run.rds} · Airflow ${run.airflow} · Spark ${run.spark} · Catalog ${run.catalog} · gen ${run.generation}`,
    );
  }

  if (snapshot.sparkApplications.status === "available") {
    const counts = snapshot.sparkApplications.counts;
    lines.push(
      `SPARK    applications ${snapshot.sparkApplications.total} · Pending ${counts.Pending} · Running ${counts.Running} · Completed ${counts.Completed}`,
    );
    lines.push(
      `         ${snapshot.sparkApplications.runs.map((run) =>
        `Run ${run.alias} ${run.state} uid ${run.uidHash ? run.uidHash.slice(0, 8) : "-"}`,
      ).join(" · ")}`,
    );
  } else {
    lines.push(`SPARK    applications unavailable/${snapshot.sparkApplications.error}`);
    lines.push(
      `         persisted RDS UID ${snapshot.runs.entries.map((run) =>
        `Run ${run.alias} ${run.uidHash ? run.uidHash.slice(0, 8) : "-"}`,
      ).join(" · ")}`,
    );
  }

  if (snapshot.pods.status === "available") {
    lines.push("PODS     per Run: driver P/R/C · executor P/R/C");
    for (const run of snapshot.pods.runs) {
      lines.push(
        `         Run ${run.alias}  driver ${roleText(run.counts.driver)} · executor ${roleText(run.counts.executor)}`,
      );
    }
  } else {
    lines.push(`PODS     unavailable/${snapshot.pods.error}`);
  }

  const isolation = snapshot.isolation.fields;
  lines.push(
    `ISOLATION group ${isolation.consumerGroups.unique}/3 unique · table ${isolation.icebergTables.unique}/3 unique · output ${isolation.outputs.unique}/3 unique · checkpoint ${isolation.checkpoints.unique}/3 unique`,
  );

  if (snapshot.nodes.status === "available") {
    const generalNodes = runningNodeCount(snapshot.nodes, "asklake-general");
    const sparkNodes = runningNodeCount(snapshot.nodes, "asklake-spark");
    const groups = snapshot.nodes.groups.length
      ? snapshot.nodes.groups.map((group) =>
          `${group.pool.replace("asklake-", "")}/${group.type}/${group.state}=${group.count}`,
        ).join(" · ")
      : "managed nodes 0";
    lines.push(`NODES    General ${generalNodes} · Spark ${sparkNodes} · ${groups}`);
    lines.push(
      `         Spark baseline ${snapshot.nodeScale.baselineSparkNodes} → current ${snapshot.nodeScale.sparkNodes} · ${snapshot.nodeScale.status}`,
    );
  } else {
    lines.push(`NODES    unavailable/${snapshot.nodes.error}`);
  }

  lines.push("─".repeat(96));
  lines.push("EVENTS   recent scheduling/NodeClaim/node/consolidation signals (15m, identifiers hidden)");
  if (snapshot.events.items.length === 0) {
    lines.push(
      `         ${snapshot.events.status === "available" ? "no matching recent events" : snapshot.events.error}`,
    );
  } else {
    for (const event of snapshot.events.items) {
      lines.push(
        `         ${formatClock(event.observedAt)} ${event.type.padEnd(7)} ${event.reason.padEnd(30)} ${event.kind} x${event.count}`,
      );
    }
  }
  lines.push("─".repeat(96));
  const continuousGate =
    snapshot.gates.continuous === "ready-0" ? "0" : snapshot.gates.continuous;
  lines.push(
    `GATES    3 runs active ${snapshot.gates.threeRunsActive} · 3 application UIDs unique ${snapshot.gates.applicationUidsUnique} · isolation valid ${snapshot.gates.isolation} · Continuous ${continuousGate} · node scale ${snapshot.gates.nodeScale}`,
  );
  lines.push(
    `SETUP    scale slots ${snapshot.runtimeConfig.scaleSlots ?? 0}/3 · candidate jobs ${snapshot.setup.candidateDistinctScaleSlots ?? 0}/3 · backend multi-slot ${snapshot.setup.multiSlotRuntimeSupport === true ? "ready" : snapshot.setup.multiSlotRuntimeSupport === false ? "unavailable" : "unknown"}`,
  );
  lines.push(
    `BLOCKERS ${snapshot.blockers.length ? snapshot.blockers.join(" · ") : "none"}`,
  );
  if (snapshot.errors.length) {
    lines.push(`LIMITS   ${snapshot.errors.join(" · ")}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    namespace: DEFAULT_NAMESPACE,
    interval: 5,
    once: false,
    clear: true,
    record: DEFAULT_RECORD,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--namespace") options.namespace = argv[++index];
    else if (argument === "--interval") options.interval = numberOr(argv[++index], -1);
    else if (argument === "--record") options.record = resolve(argv[++index]);
    else if (argument === "--no-record") options.record = null;
    else if (argument === "--once") options.once = true;
    else if (argument === "--no-clear") options.clear = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (!options.namespace || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(options.namespace)) {
    throw new Error("namespace must be a DNS-safe Kubernetes namespace");
  }
  if (!Number.isInteger(options.interval) || options.interval < 2) {
    throw new Error("interval must be an integer of at least 2 seconds");
  }
  return options;
}

function usage() {
  return `Usage:
  node scripts/watch-eks-day17-multi-spark.mjs [options]

Options:
  --namespace <name>       Kubernetes namespace (default: asklake-dev)
  --interval <seconds>     Refresh interval, minimum 2 (default: 5)
  --record <outside-path>  Sanitized JSONL path (default: ${DEFAULT_RECORD})
  --no-record              Do not write JSONL
  --once                   Read and render one snapshot, then exit
  --no-clear               Keep previous snapshots in terminal scrollback
  --help                   Show this help

Safety:
  Uses Kubernetes get/list/config-view, AWS list/describe, and a SELECT-only Python query
  inside an existing FastAPI Pod. It does not create, patch, delete, scale, or apply resources.
  Raw Run/Job/application/snapshot/dataset/group/table/output/checkpoint identities never leave
  the FastAPI Pod; only 12-character SHA-256 hashes and aggregate counts are returned.`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    options.record = await assertRecordPath(options.record);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const startedAt = new Date().toISOString();
  const aliasTracker = new RunAliasTracker();
  const nodeScaleTracker = new NodeScaleTracker(startedAt);
  const regionResult = await resolveAwsRegion();
  const clusterNameResult = await resolveClusterName(regionResult);
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    process.stdout.write("\nObserver stopped; no cluster resources were changed.\n");
  });

  do {
    const snapshot = await collectSnapshot(
      options,
      startedAt,
      aliasTracker,
      nodeScaleTracker,
      clusterNameResult,
      regionResult,
    );
    if (options.record) {
      await appendFile(options.record, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (options.clear && process.stdout.isTTY && !options.once) {
      process.stdout.write("\u001b[2J\u001b[H");
    }
    process.stdout.write(`${renderDashboard(snapshot, options)}\n`);
    if (options.once || stopping) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.interval * 1_000));
  } while (!stopping);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
