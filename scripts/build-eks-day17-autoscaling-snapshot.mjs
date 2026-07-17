#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [inputDirectory, evidencePath, phase] = process.argv.slice(2);
const runToken = process.env.ASKLAKE_DAY17_RUN_TOKEN;
if (!inputDirectory || !evidencePath || !["baseline", "sample", "final"].includes(phase) || !runToken) {
  console.error("usage: ASKLAKE_DAY17_RUN_TOKEN=<private> build-eks-day17-autoscaling-snapshot.mjs <input-dir> <evidence.json> <baseline|sample|final>");
  process.exit(2);
}

const readJson = (name, fallback = undefined) => {
  try {
    return JSON.parse(readFileSync(`${inputDirectory}/${name}`, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
};
const items = (name) => readJson(name, { items: [] }).items ?? [];
const fingerprint = createHash("sha256").update(runToken).digest("hex").slice(0, 16);
const labelKey = "asklake.io/day17-run";

const quantity = (value, cpu = false) => {
  if (!value) return 0;
  const match = String(value).match(/^([0-9.]+)([a-zA-Z]+)?$/);
  if (!match) return 0;
  const number = Number(match[1]);
  const suffix = match[2] ?? "";
  if (cpu) return suffix === "m" ? number : number * 1000;
  const factors = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3 };
  return number * (factors[suffix] ?? 1);
};
const compactResources = (cpuMillicores, memoryBytes) => ({
  cpuMillicores: Math.round(cpuMillicores),
  memoryMiB: Math.round(memoryBytes / 1024 / 1024),
});
const podRequests = (pod) => {
  const sum = (containers = []) => containers.reduce((result, container) => ({
    cpu: result.cpu + quantity(container.resources?.requests?.cpu, true),
    memory: result.memory + quantity(container.resources?.requests?.memory),
  }), { cpu: 0, memory: 0 });
  const regular = sum(pod.spec?.containers);
  const init = (pod.spec?.initContainers ?? []).reduce((result, container) => ({
    cpu: Math.max(result.cpu, quantity(container.resources?.requests?.cpu, true)),
    memory: Math.max(result.memory, quantity(container.resources?.requests?.memory)),
  }), { cpu: 0, memory: 0 });
  return { cpu: Math.max(regular.cpu, init.cpu), memory: Math.max(regular.memory, init.memory) };
};
const requirement = (pool, key) => pool.spec?.template?.spec?.requirements?.find((entry) => entry.key === key);
const poolSummary = (pool) => ({
  ready: pool.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false,
  workloadClass: pool.spec?.template?.metadata?.labels?.["asklake.io/workload-class"] ?? null,
  capacityTypes: [...(requirement(pool, "karpenter.sh/capacity-type")?.values ?? [])].sort(),
  instanceCategories: [...(requirement(pool, "eks.amazonaws.com/instance-category")?.values ?? [])].sort(),
  instanceGenerationGreaterThan: Number(requirement(pool, "eks.amazonaws.com/instance-generation")?.values?.[0] ?? -1),
  architecture: requirement(pool, "kubernetes.io/arch")?.values?.[0] ?? null,
  cpuLimit: String(pool.spec?.limits?.cpu ?? ""),
  memoryLimit: String(pool.spec?.limits?.memory ?? ""),
  consolidationPolicy: pool.spec?.disruption?.consolidationPolicy ?? null,
  consolidateAfter: pool.spec?.disruption?.consolidateAfter ?? null,
  disruptionBudget: pool.spec?.disruption?.budgets?.[0]?.nodes ?? null,
  expireAfter: pool.spec?.template?.spec?.expireAfter ?? null,
  terminationGracePeriod: pool.spec?.template?.spec?.terminationGracePeriod ?? null,
  sparkTaint: (pool.spec?.template?.spec?.taints ?? []).some((taint) =>
    taint.key === "asklake.io/workload-class" && taint.value === "spark" && taint.effect === "NoSchedule"),
});
const valueSummary = (name, values) => {
  const pool = values[name] ?? {};
  return {
    ready: true,
    workloadClass: name,
    capacityTypes: [...(pool.capacityTypes ?? [])].sort(),
    instanceCategories: [...(pool.instanceCategories ?? [])].sort(),
    instanceGenerationGreaterThan: Number(pool.instanceGenerationMin ?? 0) - 1,
    architecture: "amd64",
    cpuLimit: String(pool.limits?.cpu ?? ""),
    memoryLimit: String(pool.limits?.memory ?? ""),
    consolidationPolicy: pool.disruption?.consolidationPolicy ?? null,
    consolidateAfter: pool.disruption?.consolidateAfter ?? null,
    disruptionBudget: pool.disruption?.budget ?? null,
    expireAfter: pool.expireAfter ?? null,
    terminationGracePeriod: pool.terminationGracePeriod ?? null,
    sparkTaint: name === "spark",
  };
};
const stableJson = (value) => JSON.stringify(value, Object.keys(value).sort());

const nodePools = items("nodepools.json");
const helmValues = readJson("auto-mode-values.json");
const pools = {};
for (const name of ["general", "spark"]) {
  const live = nodePools.find((pool) => pool.metadata?.name === `asklake-${name}`);
  const source = valueSummary(name, helmValues);
  const observed = live ? poolSummary(live) : null;
  pools[name] = { source, live: observed, sourceMatchesLive: observed ? stableJson(source) === stableJson(observed) : false };
}

const nodes = items("nodes.json");
const pods = items("pods.json");
const nodePoolByName = new Map(nodes.map((node) => [node.metadata?.name, node.metadata?.labels?.["karpenter.sh/nodepool"] ?? "unmanaged"]));
const capacity = { general: { nodes: 0, cpu: 0, memory: 0 }, spark: { nodes: 0, cpu: 0, memory: 0 }, other: { nodes: 0, cpu: 0, memory: 0 } };
for (const node of nodes) {
  const rawPool = node.metadata?.labels?.["karpenter.sh/nodepool"];
  const key = rawPool === "asklake-general" ? "general" : rawPool === "asklake-spark" ? "spark" : "other";
  capacity[key].nodes += 1;
  capacity[key].cpu += quantity(node.status?.allocatable?.cpu, true);
  capacity[key].memory += quantity(node.status?.allocatable?.memory);
}
const requests = { general: { pods: 0, cpu: 0, memory: 0 }, spark: { pods: 0, cpu: 0, memory: 0 }, other: { pods: 0, cpu: 0, memory: 0 }, pending: { pods: 0, cpu: 0, memory: 0 } };
for (const pod of pods) {
  if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
  const rawPool = nodePoolByName.get(pod.spec?.nodeName);
  const key = !pod.spec?.nodeName ? "pending" : rawPool === "asklake-general" ? "general" : rawPool === "asklake-spark" ? "spark" : "other";
  const resource = podRequests(pod);
  requests[key].pods += 1;
  requests[key].cpu += resource.cpu;
  requests[key].memory += resource.memory;
}
const capacityEvidence = Object.fromEntries(Object.entries(capacity).map(([key, value]) => [key, { nodes: value.nodes, allocatable: compactResources(value.cpu, value.memory) }]));
const requestEvidence = Object.fromEntries(Object.entries(requests).map(([key, value]) => [key, { pods: value.pods, requests: compactResources(value.cpu, value.memory) }]));

const deployments = items("deployments.json");
const expectedPool = (name) => {
  if (["frontend", "fastapi", "trino-result-collector", "asklake-backend", "asklake-frontend", "asklake-trino"].includes(name)) return "general";
  if (name?.startsWith("asklake-airflow-")) return "general";
  return null;
};
const matchesSelector = (labels, selector) => Object.entries(selector ?? {}).every(([key, value]) => labels?.[key] === value);
const placements = deployments.map((deployment) => {
  const name = deployment.metadata?.name;
  const expected = expectedPool(name);
  if (!expected) return null;
  const selector = deployment.spec?.template?.spec?.nodeSelector?.["asklake.io/workload-class"] ?? null;
  const selectedPods = pods.filter((pod) => matchesSelector(pod.metadata?.labels, deployment.spec?.selector?.matchLabels));
  const scheduledPools = [...new Set(selectedPods.map((pod) => nodePoolByName.get(pod.spec?.nodeName) ?? "pending"))].sort();
  return { component: name, expectedPool: expected, selector, selectorMatches: selector === expected, scheduledPools, scheduledPoolMatches: scheduledPools.length > 0 && scheduledPools.every((pool) => pool === `asklake-${expected}`) };
}).filter(Boolean);

const sparkApplications = items("sparkapplications.json");
const sparkPlacement = sparkApplications.map((application) => {
  const check = (spec) => ({
    selectorMatches: spec?.nodeSelector?.["asklake.io/workload-class"] === "spark",
    tolerationMatches: (spec?.tolerations ?? []).some((entry) => entry.key === "asklake.io/workload-class" && entry.value === "spark" && entry.effect === "NoSchedule"),
  });
  return { state: application.status?.applicationState?.state ?? "UNKNOWN", driver: check(application.spec?.driver), executor: check(application.spec?.executor) };
});

const hpas = items("hpas.json").map((hpa) => ({
  name: hpa.metadata?.name,
  generation: hpa.metadata?.generation ?? 0,
  minReplicas: hpa.spec?.minReplicas ?? 1,
  maxReplicas: hpa.spec?.maxReplicas ?? 0,
  currentReplicas: hpa.status?.currentReplicas ?? 0,
  desiredReplicas: hpa.status?.desiredReplicas ?? 0,
  cpuTargets: (hpa.spec?.metrics ?? []).filter((metric) => metric.resource?.name === "cpu").map((metric) => metric.resource?.target?.averageUtilization ?? null),
  behavior: hpa.spec?.behavior ?? null,
}));
const helmReleases = readJson("helm-releases.json", []).filter((release) => release.namespace === process.env.ASKLAKE_EKS_NAMESPACE).map((release) => ({
  name: release.name,
  revision: Number(release.revision),
  chart: release.chart,
  status: release.status,
})).sort((a, b) => a.name.localeCompare(b.name));
const identities = {
  deployments: deployments.map((deployment) => ({ name: deployment.metadata?.name, generation: deployment.metadata?.generation ?? 0 })).sort((a, b) => a.name.localeCompare(b.name)),
  hpas: hpas.map(({ currentReplicas: _current, desiredReplicas: _desired, ...identity }) => identity),
  helmReleases,
};
const identityHash = createHash("sha256").update(JSON.stringify(identities)).digest("hex").slice(0, 16);

const owned = (resource) => resource.metadata?.labels?.[labelKey] === fingerprint;
const jobs = items("jobs.json");
const activeJobs = jobs.filter((job) => Number(job.status?.active ?? 0) > 0);
const activeSpark = sparkApplications.filter((application) => !["COMPLETED", "FAILED"].includes(application.status?.applicationState?.state ?? ""));
const nonTerminalPods = pods.filter((pod) => !["Succeeded", "Failed"].includes(pod.status?.phase));
const terminating = nonTerminalPods.filter((pod) => pod.metadata?.deletionTimestamp);
const pending = nonTerminalPods.filter((pod) => pod.status?.phase === "Pending");
const endpointDrainCandidates = items("endpointslices.json").flatMap((slice) => slice.endpoints ?? []).filter((endpoint) => endpoint.conditions?.terminating === true || endpoint.conditions?.ready === false).length;
const blockers = {
  unrelatedActiveJobs: activeJobs.filter((job) => !owned(job)).length,
  unrelatedActiveSparkApplications: activeSpark.filter((application) => !owned(application)).length,
  unrelatedPendingPods: pending.filter((pod) => !owned(pod)).length,
  unrelatedTerminatingPods: terminating.filter((pod) => !owned(pod)).length,
  endpointDrainCandidates,
};
const controlledResources = {
  activeJobs: activeJobs.filter(owned).length,
  activeSparkApplications: activeSpark.filter(owned).length,
  nonTerminalPods: nonTerminalPods.filter(owned).length,
};
const placementReady = placements.every((placement) => placement.selectorMatches && placement.scheduledPoolMatches) &&
  sparkPlacement.every((placement) => placement.driver.selectorMatches && placement.driver.tolerationMatches && placement.executor.selectorMatches && placement.executor.tolerationMatches);
const poolReady = Object.values(pools).every((pool) => pool.sourceMatchesLive && pool.live?.ready);
const exclusiveWindowReady = Object.values(blockers).every((count) => count === 0);

let evidence = phase === "baseline" ? null : readJson("existing-evidence.json");
if (phase !== "baseline" && evidence.runFingerprint !== fingerprint) {
  throw new Error("run token does not match the existing evidence");
}
const snapshot = {
  phase,
  capturedAt: new Date().toISOString(),
  pools,
  capacity: capacityEvidence,
  workloadRequests: requestEvidence,
  placements,
  sparkPlacement,
  hpa: hpas,
  identityHash,
  blockers,
  controlledResources,
  gates: { poolReady, placementReady, exclusiveWindowReady },
};
if (phase === "baseline") {
  evidence = { contractVersion: "1.0", runFingerprint: fingerprint, labelContract: `${labelKey}=<run-fingerprint>`, baselineIdentityHash: identityHash, snapshots: [snapshot], cleanup: { verified: false } };
} else {
  snapshot.identityMatchesBaseline = identityHash === evidence.baselineIdentityHash;
  snapshot.gates.identityMatchesBaseline = snapshot.identityMatchesBaseline;
  evidence.snapshots.push(snapshot);
  if (phase === "final") {
    evidence.cleanup = {
      verified: Object.values(controlledResources).every((count) => count === 0),
      controlledResources,
      verifiedAt: new Date().toISOString(),
    };
    evidence.finalGatePassed = evidence.cleanup.verified && snapshot.identityMatchesBaseline && poolReady && placementReady && exclusiveWindowReady;
  }
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
