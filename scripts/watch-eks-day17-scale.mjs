#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, chmod, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_NAMESPACE = process.env.ASKLAKE_EKS_NAMESPACE || "asklake-dev";
const EVENT_REASONS = new Set([
  "Nominated",
  "Scheduled",
  "FailedScheduling",
  "DisruptionTerminating",
  "Drained",
  "RemovingNode",
  "Unconsolidatable",
  "ConsolidationRejected",
  "FailedDraining",
  "TerminationGracePeriodExpiring",
  "ScalingReplicaSet",
  "SuccessfulRescale",
  "FailedGetResourceMetric",
  "Created",
  "Launched",
  "Registered",
  "Initialized",
  "Ready",
  "NodeReady",
  "Consolidated",
  "Disrupted",
  "Terminating",
  "Deleting",
  "DisruptionBlocked",
]);
const SAFE_EVENT_KINDS = new Set([
  "Deployment",
  "HorizontalPodAutoscaler",
  "Node",
  "NodeClaim",
  "NodePool",
  "Pod",
  "ReplicaSet",
]);
const EXPECTED_NODE_POOLS = new Set(["asklake-general", "asklake-spark"]);

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedText(value, fallback, maximumLength = 32) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:/ -]/g, "?");
  return normalized.slice(0, maximumLength) || fallback;
}

export function sanitizeFailure(error) {
  const raw = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join(" ");
  if (/notfound|not found/i.test(raw)) return "not found";
  if (/forbidden|rbac|cannot list|cannot get/i.test(raw)) return "RBAC forbidden";
  if (/accessdenied|not authorized|unauthorizedoperation/i.test(raw)) {
    return "AWS access denied";
  }
  if (/expiredtoken|invalidclienttokenid|credentials|credential/i.test(raw)) {
    return "AWS authentication error";
  }
  if (/timed out|timeout/i.test(raw)) return "command timed out";
  if (/enoent/i.test(raw)) return "required command unavailable";
  return "read command failed";
}

export async function runJson(command, args, timeout = 12_000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, error: sanitizeFailure(error) };
  }
}

export async function runText(command, args, timeout = 12_000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout,
    });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, error: sanitizeFailure(error) };
  }
}

export function parseHpa(document) {
  if (!document) return { state: "not-deployed" };
  const cpuMetric = (document.status?.currentMetrics || []).find(
    (metric) => metric.type === "Resource" && metric.resource?.name === "cpu",
  );
  const targetMetric = (document.spec?.metrics || []).find(
    (metric) => metric.type === "Resource" && metric.resource?.name === "cpu",
  );
  const conditions = (document.status?.conditions || []).map((condition) => ({
    type: boundedText(condition.type, "Unknown"),
    status: condition.status === "True" ? "True" : condition.status === "False" ? "False" : "Unknown",
  }));
  return {
    state: "deployed",
    currentReplicas: numberOr(document.status?.currentReplicas),
    desiredReplicas: numberOr(document.status?.desiredReplicas),
    minReplicas: numberOr(document.spec?.minReplicas),
    maxReplicas: numberOr(document.spec?.maxReplicas),
    currentCpuPercent:
      cpuMetric?.resource?.current?.averageUtilization == null
        ? null
        : numberOr(cpuMetric.resource.current.averageUtilization),
    targetCpuPercent:
      targetMetric?.resource?.target?.averageUtilization == null
        ? null
        : numberOr(targetMetric.resource.target.averageUtilization),
    conditions,
  };
}

export function parseDeployment(document) {
  if (!document) return { state: "not-found" };
  return {
    state: "available",
    desired: numberOr(document.spec?.replicas),
    updated: numberOr(document.status?.updatedReplicas),
    ready: numberOr(document.status?.readyReplicas),
    available: numberOr(document.status?.availableReplicas),
    unavailable: numberOr(document.status?.unavailableReplicas),
  };
}

function isReadyPod(pod) {
  const statuses = pod.status?.containerStatuses || [];
  return statuses.length > 0 && statuses.every((status) => status.ready === true);
}

function isBackendPod(pod) {
  const labels = pod.metadata?.labels || {};
  return (
    labels["app.kubernetes.io/component"] === "backend" ||
    (pod.spec?.containers || []).some((container) => container.name === "fastapi")
  );
}

function sparkRole(pod) {
  const labels = pod.metadata?.labels || {};
  if (labels["spark-role"] === "driver" || labels["sparkoperator.k8s.io/role"] === "driver") {
    return "driver";
  }
  if (
    labels["spark-role"] === "executor" ||
    labels["sparkoperator.k8s.io/role"] === "executor"
  ) {
    return "executor";
  }
  return "other";
}

function isSparkPod(pod) {
  const labels = pod.metadata?.labels || {};
  return (
    sparkRole(pod) !== "other" ||
    labels["app.kubernetes.io/name"] === "asklake-spark" ||
    Boolean(labels["asklake.io/run-id"]) ||
    Boolean(labels["sparkoperator.k8s.io/app-name"])
  );
}

function blankPodSummary() {
  return {
    total: 0,
    ready: 0,
    active: 0,
    terminating: 0,
    phases: { Pending: 0, Running: 0, Succeeded: 0, Failed: 0, Unknown: 0 },
  };
}

export function parsePods(document) {
  const backend = blankPodSummary();
  const spark = {
    ...blankPodSummary(),
    drivers: 0,
    executors: 0,
    other: 0,
    runs: 0,
  };
  const backendNames = new Set();
  const sparkNames = new Set();
  const runReferences = new Set();

  for (const pod of document?.items || []) {
    const name = pod.metadata?.name;
    const phase = ["Pending", "Running", "Succeeded", "Failed"].includes(pod.status?.phase)
      ? pod.status.phase
      : "Unknown";
    const terminating = Boolean(pod.metadata?.deletionTimestamp);
    const ready = isReadyPod(pod);

    if (isBackendPod(pod)) {
      backend.total += 1;
      backend.phases[phase] += 1;
      if (ready) backend.ready += 1;
      if (phase === "Pending" || phase === "Running") backend.active += 1;
      if (terminating) backend.terminating += 1;
      if (name) backendNames.add(name);
    }

    if (isSparkPod(pod)) {
      spark.total += 1;
      spark.phases[phase] += 1;
      if (ready) spark.ready += 1;
      if (phase === "Pending" || phase === "Running") spark.active += 1;
      if (terminating) spark.terminating += 1;
      const role = sparkRole(pod);
      if (role === "driver") spark.drivers += 1;
      else if (role === "executor") spark.executors += 1;
      else spark.other += 1;
      if (name) sparkNames.add(name);
      const runReference = pod.metadata?.labels?.["asklake.io/run-id"];
      if (runReference) runReferences.add(runReference);
    }
  }
  spark.runs = runReferences.size;

  return { backend, spark, backendNames, sparkNames };
}

export function parseCpuMillicores(quantity) {
  if (typeof quantity !== "string") return 0;
  if (quantity.endsWith("n")) return numberOr(quantity.slice(0, -1)) / 1_000_000;
  if (quantity.endsWith("u")) return numberOr(quantity.slice(0, -1)) / 1_000;
  if (quantity.endsWith("m")) return numberOr(quantity.slice(0, -1));
  return numberOr(quantity) * 1_000;
}

export function parseMemoryBytes(quantity) {
  if (typeof quantity !== "string") return 0;
  const match = quantity.match(/^([0-9.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return 0;
  const multipliers = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
  };
  return numberOr(match[1]) * (multipliers[match[2]] || 1);
}

function aggregateContainerMetrics(podMetrics) {
  return (podMetrics?.containers || []).reduce(
    (total, container) => {
      total.cpuMillicores += parseCpuMillicores(container.usage?.cpu);
      total.memoryBytes += parseMemoryBytes(container.usage?.memory);
      return total;
    },
    { cpuMillicores: 0, memoryBytes: 0 },
  );
}

export function parsePodMetrics(document, backendNames, sparkNames) {
  const result = {
    status: "available",
    backend: { pods: 0, cpuMillicores: 0, memoryBytes: 0 },
    spark: { pods: 0, cpuMillicores: 0, memoryBytes: 0 },
  };
  for (const podMetric of document?.items || []) {
    const name = podMetric.metadata?.name;
    const aggregate = aggregateContainerMetrics(podMetric);
    if (backendNames.has(name)) {
      result.backend.pods += 1;
      result.backend.cpuMillicores += aggregate.cpuMillicores;
      result.backend.memoryBytes += aggregate.memoryBytes;
    }
    if (sparkNames.has(name)) {
      result.spark.pods += 1;
      result.spark.cpuMillicores += aggregate.cpuMillicores;
      result.spark.memoryBytes += aggregate.memoryBytes;
    }
  }
  return result;
}

export function parseManagedInstances(document) {
  const groups = new Map();
  for (const reservation of document?.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const tags = Object.fromEntries(
        (instance.Tags || [])
          .filter((tag) => typeof tag.Key === "string")
          .map((tag) => [tag.Key, tag.Value]),
      );
      const rawPool = tags["eks:kubernetes-node-pool-name"];
      const pool = EXPECTED_NODE_POOLS.has(rawPool) ? rawPool : "other";
      const type = boundedText(instance.InstanceType, "unknown", 24);
      const state = boundedText(instance.State?.Name, "unknown", 20);
      const key = `${pool}|${type}|${state}`;
      groups.set(key, {
        pool,
        type,
        state,
        count: (groups.get(key)?.count || 0) + 1,
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    `${left.pool}|${left.type}|${left.state}`.localeCompare(
      `${right.pool}|${right.type}|${right.state}`,
    ),
  );
}

export function parseEvents(document, now = new Date(), lookbackMinutes = 15) {
  const cutoff = now.getTime() - lookbackMinutes * 60_000;
  return (document?.items || [])
    .map((event) => {
      const observedAt =
        event.eventTime ||
        event.series?.lastObservedTime ||
        event.lastTimestamp ||
        event.metadata?.creationTimestamp;
      const timestamp = Date.parse(observedAt);
      return {
        observedAt,
        timestamp,
        reason: event.reason,
        type: event.type === "Warning" ? "Warning" : "Normal",
        kind: SAFE_EVENT_KINDS.has(event.involvedObject?.kind)
          ? event.involvedObject.kind
          : "Object",
        count: Math.max(1, numberOr(event.series?.count ?? event.count, 1)),
      };
    })
    .filter(
      (event) =>
        Number.isFinite(event.timestamp) &&
        event.timestamp >= cutoff &&
        EVENT_REASONS.has(event.reason),
    )
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 8)
    .map(({ timestamp: _timestamp, ...event }) => event);
}

export function parseLoadStatus(document) {
  if (!document || typeof document !== "object") return { state: "not-connected" };
  return {
    state: "connected",
    phase: boundedText(document.phase, "unknown", 24),
    targetRps: Math.max(0, numberOr(document.targetRps ?? document.rps)),
    totalRequests: Math.max(0, numberOr(document.totalRequests ?? document.total)),
    non2xx: Math.max(0, numberOr(document.non2xx)),
    serverErrors: Math.max(0, numberOr(document.serverErrors)),
    p95Ms:
      document.p95Ms == null ? null : Math.max(0, Math.round(numberOr(document.p95Ms))),
  };
}

function validAwsRegion(value) {
  return typeof value === "string" && /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value);
}

export function parseAwsRegionFromKubeconfig(document) {
  const candidates = [];
  for (const user of document?.users || []) {
    const args = user.user?.exec?.args || [];
    const regionArgument = args.indexOf("--region");
    if (regionArgument >= 0) candidates.push(args[regionArgument + 1]);
    for (const environment of user.user?.exec?.env || []) {
      if (environment.name === "AWS_REGION" || environment.name === "AWS_DEFAULT_REGION") {
        candidates.push(environment.value);
      }
    }
  }
  const contextName = document?.["current-context"];
  const arnRegion = typeof contextName === "string" ? contextName.match(/^arn:[^:]+:eks:([^:]+):/)?.[1] : null;
  if (arnRegion) candidates.push(arnRegion);
  return candidates.find(validAwsRegion) || null;
}

function publicPodSummary(summary) {
  return {
    total: summary.total,
    ready: summary.ready,
    active: summary.active,
    terminating: summary.terminating,
    phases: summary.phases,
    ...(summary.drivers == null
      ? {}
      : {
          drivers: summary.drivers,
          executors: summary.executors,
          other: summary.other,
          runs: summary.runs,
        }),
  };
}

async function readLoadStatus(path) {
  if (!path) return { state: "not-connected" };
  try {
    return parseLoadStatus(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { state: "unavailable" };
  }
}

export async function resolveAwsRegion() {
  const environmentRegion =
    process.env.ASKLAKE_AWS_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;
  if (validAwsRegion(environmentRegion)) return { ok: true, value: environmentRegion };

  const kubeconfig = await runJson("kubectl", ["config", "view", "--minify", "-o", "json"]);
  if (kubeconfig.ok) {
    const kubeconfigRegion = parseAwsRegionFromKubeconfig(kubeconfig.value);
    if (kubeconfigRegion) return { ok: true, value: kubeconfigRegion };
  }

  const configuredRegion = await runText("aws", ["configure", "get", "region"]);
  if (configuredRegion.ok && validAwsRegion(configuredRegion.value)) {
    return { ok: true, value: configuredRegion.value };
  }
  return { ok: false, error: "set ASKLAKE_AWS_REGION" };
}

export async function resolveClusterName(regionResult) {
  if (process.env.ASKLAKE_EKS_CLUSTER_NAME) {
    return { ok: true, value: process.env.ASKLAKE_EKS_CLUSTER_NAME };
  }
  if (!regionResult.ok) return regionResult;
  const result = await runJson("aws", [
    "eks",
    "list-clusters",
    "--region",
    regionResult.value,
    "--output",
    "json",
  ]);
  if (!result.ok) return result;
  if (result.value?.clusters?.length !== 1) {
    return { ok: false, error: "set ASKLAKE_EKS_CLUSTER_NAME" };
  }
  return { ok: true, value: result.value.clusters[0] };
}

export async function collectNodeGroups(clusterNameResult, regionResult) {
  if (!clusterNameResult.ok) {
    return { status: "unavailable", error: clusterNameResult.error, groups: [] };
  }
  if (!regionResult.ok) {
    return { status: "unavailable", error: regionResult.error, groups: [] };
  }
  const result = await runJson(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--region",
      regionResult.value,
      "--include-managed-resources",
      "--filters",
      `Name=tag:eks:eks-cluster-name,Values=${clusterNameResult.value}`,
      "Name=instance-state-name,Values=pending,running,shutting-down",
      "--output",
      "json",
    ],
    20_000,
  );
  if (!result.ok) return { status: "unavailable", error: result.error, groups: [] };
  return { status: "available", groups: parseManagedInstances(result.value) };
}

function unavailable(state, error) {
  return { state, error };
}

async function collectSnapshot(options, clusterNameResult, regionResult) {
  const namespace = options.namespace;
  const metricsPath = `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`;
  const [hpaResult, deploymentResult, podsResult, metricsResult, eventsResult, nodes, load] =
    await Promise.all([
      runJson("kubectl", ["get", "hpa", "fastapi", "-n", namespace, "-o", "json"]),
      runJson("kubectl", ["get", "deployment", "fastapi", "-n", namespace, "-o", "json"]),
      runJson("kubectl", ["get", "pods", "-n", namespace, "-o", "json"]),
      runJson("kubectl", ["get", "--raw", metricsPath]),
      runJson("kubectl", ["get", "events", "-A", "-o", "json"]),
      collectNodeGroups(clusterNameResult, regionResult),
      readLoadStatus(options.loadStatus),
    ]);

  const parsedPods = podsResult.ok
    ? parsePods(podsResult.value)
    : {
        backend: blankPodSummary(),
        spark: { ...blankPodSummary(), drivers: 0, executors: 0, other: 0, runs: 0 },
        backendNames: new Set(),
        sparkNames: new Set(),
      };
  const hpa = hpaResult.ok
    ? parseHpa(hpaResult.value)
    : hpaResult.error === "not found"
      ? parseHpa(null)
      : unavailable("unavailable", hpaResult.error);
  const deployment = deploymentResult.ok
    ? parseDeployment(deploymentResult.value)
    : unavailable("unavailable", deploymentResult.error);
  const podMetrics = metricsResult.ok
    ? parsePodMetrics(metricsResult.value, parsedPods.backendNames, parsedPods.sparkNames)
    : { status: "unavailable", error: metricsResult.error };
  const events = eventsResult.ok
    ? { status: "available", items: parseEvents(eventsResult.value) }
    : { status: "unavailable", error: eventsResult.error, items: [] };

  const errors = [
    !podsResult.ok ? `Pods: ${podsResult.error}` : null,
    hpa.state === "unavailable" ? `HPA: ${hpa.error}` : null,
    deployment.state === "unavailable" ? `Deployment: ${deployment.error}` : null,
    podMetrics.status === "unavailable" ? `Pod metrics: ${podMetrics.error}` : null,
    nodes.status === "unavailable" ? `Nodes: ${nodes.error}` : null,
    events.status === "unavailable" ? `Events: ${events.error}` : null,
  ].filter(Boolean);

  return {
    contractVersion: "1.0",
    observedAt: new Date().toISOString(),
    mode: "read-only",
    hpa,
    fastapi: {
      deployment,
      pods: publicPodSummary(parsedPods.backend),
    },
    podMetrics,
    load,
    spark: publicPodSummary(parsedPods.spark),
    nodes,
    events,
    gates: {
      hpaMetrics:
        hpa.state === "deployed" && hpa.currentCpuPercent != null
          ? "ready"
          : hpa.state === "not-deployed"
            ? "waiting-for-deploy"
            : "waiting-for-metrics",
      fastapi:
        deployment.state === "available" &&
        deployment.desired > 0 &&
        deployment.ready >= deployment.desired
          ? "ready"
          : "not-ready",
      spark: parsedPods.spark.active > 0 ? "active" : "idle",
      nodes: nodes.status,
    },
    errors,
  };
}

function formatCpu(cpuMillicores) {
  return `${Math.round(cpuMillicores)}m`;
}

function formatMemory(memoryBytes) {
  if (memoryBytes >= 1024 ** 3) return `${(memoryBytes / 1024 ** 3).toFixed(2)}Gi`;
  return `${Math.round(memoryBytes / 1024 ** 2)}Mi`;
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

function renderSnapshot(snapshot, options) {
  const lines = [];
  lines.push("AskLake Day 17 Scale Observer  [READ-ONLY]");
  lines.push(
    `${formatClock(snapshot.observedAt)} KST · ${options.interval}s refresh · Ctrl-C 종료` +
      (options.record ? " · sanitized JSONL 기록 중" : ""),
  );
  lines.push("─".repeat(78));

  if (snapshot.load.state === "connected") {
    lines.push(
      `LOAD     ${snapshot.load.phase} · target ${snapshot.load.targetRps} rps · total ${snapshot.load.totalRequests} · non-2xx ${snapshot.load.non2xx} · 5xx ${snapshot.load.serverErrors} · p95 ${snapshot.load.p95Ms ?? "?"}ms`,
    );
  } else {
    lines.push(`LOAD     ${snapshot.load.state === "not-connected" ? "not connected" : "status unavailable"}`);
  }

  if (snapshot.hpa.state === "deployed") {
    lines.push(
      `HPA      replicas ${snapshot.hpa.currentReplicas} → ${snapshot.hpa.desiredReplicas} [${snapshot.hpa.minReplicas}..${snapshot.hpa.maxReplicas}] · CPU ${snapshot.hpa.currentCpuPercent ?? "?"}% / target ${snapshot.hpa.targetCpuPercent ?? "?"}%`,
    );
  } else {
    lines.push(
      `HPA      ${snapshot.hpa.state === "not-deployed" ? "not deployed" : snapshot.hpa.error}`,
    );
  }

  const deployment = snapshot.fastapi.deployment;
  if (deployment.state === "available") {
    lines.push(
      `FASTAPI  deploy desired ${deployment.desired} · ready ${deployment.ready} · available ${deployment.available} · unavailable ${deployment.unavailable}`,
    );
  } else {
    lines.push(`FASTAPI  deployment ${deployment.error || deployment.state}`);
  }
  lines.push(
    `         pods active ${snapshot.fastapi.pods.active} · ready ${snapshot.fastapi.pods.ready} · terminating ${snapshot.fastapi.pods.terminating}`,
  );

  if (snapshot.podMetrics.status === "available") {
    lines.push(
      `METRICS  FastAPI ${formatCpu(snapshot.podMetrics.backend.cpuMillicores)} / ${formatMemory(snapshot.podMetrics.backend.memoryBytes)} · Spark ${formatCpu(snapshot.podMetrics.spark.cpuMillicores)} / ${formatMemory(snapshot.podMetrics.spark.memoryBytes)}`,
    );
  } else {
    lines.push(
      `METRICS  ${snapshot.podMetrics.error}; HPA aggregate CPU is still observable after deploy`,
    );
  }

  lines.push(
    `SPARK    runs ${snapshot.spark.runs} · active ${snapshot.spark.active} · pending ${snapshot.spark.phases.Pending} · running ${snapshot.spark.phases.Running} · driver ${snapshot.spark.drivers} · executor ${snapshot.spark.executors}`,
  );

  if (snapshot.nodes.status === "available") {
    const groups =
      snapshot.nodes.groups.length > 0
        ? snapshot.nodes.groups
            .map((group) => `${group.pool.replace("asklake-", "")}/${group.type}/${group.state}=${group.count}`)
            .join(" · ")
        : "managed nodes 0";
    lines.push(`NODES    ${groups}`);
  } else {
    lines.push(`NODES    ${snapshot.nodes.error}`);
  }

  lines.push("─".repeat(78));
  lines.push(
    `GATES    HPA ${snapshot.gates.hpaMetrics} · FastAPI ${snapshot.gates.fastapi} · Spark ${snapshot.gates.spark} · Nodes ${snapshot.gates.nodes}`,
  );
  lines.push("EVENTS   recent autoscaling/scheduling signals (15m, identifiers hidden)");
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
  if (snapshot.errors.length > 0) {
    lines.push("─".repeat(78));
    lines.push(`LIMITS   ${snapshot.errors.join(" · ")}`);
  }
  return lines.join("\n");
}

export async function assertRecordPath(recordPath) {
  if (!recordPath) return null;
  const absolute = resolve(recordPath);
  const repository = await realpath(REPOSITORY_ROOT);
  let canonicalTarget;
  try {
    canonicalTarget = await realpath(absolute);
  } catch {
    canonicalTarget = resolve(await realpath(dirname(absolute)), basename(absolute));
  }
  const relationship = relative(repository, canonicalTarget);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw new Error("record path must be outside the repository");
  }
  await appendFile(canonicalTarget, "", { encoding: "utf8", mode: 0o600 });
  await chmod(canonicalTarget, 0o600);
  return canonicalTarget;
}

function parseArgs(argv) {
  const options = {
    namespace: DEFAULT_NAMESPACE,
    interval: 5,
    once: false,
    clear: true,
    record: null,
    loadStatus: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--namespace") options.namespace = argv[++index];
    else if (argument === "--interval") options.interval = numberOr(argv[++index], -1);
    else if (argument === "--record") options.record = resolve(argv[++index]);
    else if (argument === "--load-status") options.loadStatus = resolve(argv[++index]);
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
  node scripts/watch-eks-day17-scale.mjs [options]

Options:
  --namespace <name>       Kubernetes namespace (default: ASKLAKE_EKS_NAMESPACE or asklake-dev)
  --interval <seconds>     Refresh interval, minimum 2 (default: 5)
  --record <outside-path>  Append sanitized aggregate snapshots as mode-0600 JSONL
  --load-status <path>     Read optional load-generator aggregate status JSON
  --once                   Read and render one snapshot, then exit
  --no-clear               Keep previous snapshots in terminal scrollback
  --help                   Show this help

Cluster discovery:
  Set ASKLAKE_EKS_CLUSTER_NAME, or the observer uses the account's only visible EKS cluster.
  AWS region is read from ASKLAKE_AWS_REGION/AWS_REGION, kubeconfig, or AWS config.

Safety:
  This observer only runs kubectl get/list/raw/config-view and AWS list/describe/config reads.
  It never prints or records resource names, run IDs, ARNs, account IDs, or endpoints.`;
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

  const regionResult = await resolveAwsRegion();
  const clusterNameResult = await resolveClusterName(regionResult);
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    process.stdout.write("\nObserver stopped; no cluster resources were changed.\n");
  });

  do {
    const snapshot = await collectSnapshot(options, clusterNameResult, regionResult);
    if (options.record) {
      await appendFile(options.record, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (options.clear && process.stdout.isTTY && !options.once) {
      process.stdout.write("\u001b[2J\u001b[H");
    }
    process.stdout.write(`${renderSnapshot(snapshot, options)}\n`);
    if (options.once || stopping) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.interval * 1_000));
  } while (!stopping);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
