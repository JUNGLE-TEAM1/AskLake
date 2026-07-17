#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
const readOptionalJson = (name) => existsSync(`${inputDirectory}/${name}`) ? readJson(name) : null;
const fingerprint = createHash("sha256").update(runToken).digest("hex").slice(0, 16);
const labelKey = "asklake.io/day17-run";
const scope = process.env.ASKLAKE_DAY17_SCOPE ?? "integrated";
if (!["integrated", "isolated"].includes(scope)) throw new Error("ASKLAKE_DAY17_SCOPE must be integrated or isolated");
const owned = (resource) => resource.metadata?.labels?.[labelKey] === fingerprint;

const quantity = (value, cpu = false) => {
  if (!value) return 0;
  const match = String(value).match(/^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)?$/);
  if (!match) throw new Error("unsupported Kubernetes resource quantity");
  const number = Number(match[1]);
  const suffix = match[2] ?? "";
  if (cpu) {
    const factors = { "": 1000, m: 1, u: 1e-3, n: 1e-6 };
    if (!(suffix in factors)) throw new Error("unsupported Kubernetes CPU quantity suffix");
    return number * factors[suffix];
  }
  const factors = {
    "": 1, n: 1e-9, u: 1e-6, m: 1e-3,
    k: 1000, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  };
  if (!(suffix in factors)) throw new Error("unsupported Kubernetes memory quantity suffix");
  return number * factors[suffix];
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
  const restartable = { cpu: 0, memory: 0 };
  const initPeak = { cpu: 0, memory: 0 };
  for (const container of pod.spec?.initContainers ?? []) {
    const request = sum([container]);
    if (container.restartPolicy === "Always") {
      restartable.cpu += request.cpu;
      restartable.memory += request.memory;
      initPeak.cpu = Math.max(initPeak.cpu, restartable.cpu);
      initPeak.memory = Math.max(initPeak.memory, restartable.memory);
    } else {
      initPeak.cpu = Math.max(initPeak.cpu, restartable.cpu + request.cpu);
      initPeak.memory = Math.max(initPeak.memory, restartable.memory + request.memory);
    }
  }
  const overhead = {
    cpu: quantity(pod.spec?.overhead?.cpu, true),
    memory: quantity(pod.spec?.overhead?.memory),
  };
  return {
    cpu: Math.max(regular.cpu + restartable.cpu, initPeak.cpu) + overhead.cpu,
    memory: Math.max(regular.memory + restartable.memory, initPeak.memory) + overhead.memory,
  };
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
const allPods = items("allpods.json");
const nodePoolByName = new Map(nodes.map((node) => [node.metadata?.name, node.metadata?.labels?.["karpenter.sh/nodepool"] ?? "unmanaged"]));
const capacity = { general: { nodes: 0, cpu: 0, memory: 0 }, spark: { nodes: 0, cpu: 0, memory: 0 }, other: { nodes: 0, cpu: 0, memory: 0 } };
const requestsByNode = new Map();
for (const pod of allPods) {
  if (!pod.spec?.nodeName || ["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
  const request = podRequests(pod);
  const current = requestsByNode.get(pod.spec.nodeName) ?? { cpu: 0, memory: 0 };
  requestsByNode.set(pod.spec.nodeName, { cpu: current.cpu + request.cpu, memory: current.memory + request.memory });
}
for (const node of nodes) {
  const rawPool = node.metadata?.labels?.["karpenter.sh/nodepool"];
  const key = rawPool === "asklake-general" ? "general" : rawPool === "asklake-spark" ? "spark" : "other";
  capacity[key].nodes += 1;
  capacity[key].cpu += quantity(node.status?.allocatable?.cpu, true);
  capacity[key].memory += quantity(node.status?.allocatable?.memory);
}
const requests = { general: { pods: 0, cpu: 0, memory: 0 }, spark: { pods: 0, cpu: 0, memory: 0 }, other: { pods: 0, cpu: 0, memory: 0 }, pending: { pods: 0, cpu: 0, memory: 0 } };
for (const pod of allPods) {
  if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
  const rawPool = nodePoolByName.get(pod.spec?.nodeName);
  const key = !pod.spec?.nodeName ? "pending" : rawPool === "asklake-general" ? "general" : rawPool === "asklake-spark" ? "spark" : "other";
  const resource = podRequests(pod);
  requests[key].pods += 1;
  requests[key].cpu += resource.cpu;
  requests[key].memory += resource.memory;
}
const maxSingleNodeFree = { general: { cpu: 0, memory: 0 }, spark: { cpu: 0, memory: 0 }, other: { cpu: 0, memory: 0 } };
for (const node of nodes) {
  const rawPool = node.metadata?.labels?.["karpenter.sh/nodepool"];
  const key = rawPool === "asklake-general" ? "general" : rawPool === "asklake-spark" ? "spark" : "other";
  const requested = requestsByNode.get(node.metadata?.name) ?? { cpu: 0, memory: 0 };
  maxSingleNodeFree[key].cpu = Math.max(maxSingleNodeFree[key].cpu, quantity(node.status?.allocatable?.cpu, true) - requested.cpu);
  maxSingleNodeFree[key].memory = Math.max(maxSingleNodeFree[key].memory, quantity(node.status?.allocatable?.memory) - requested.memory);
}
const capacityEvidence = Object.fromEntries(Object.entries(capacity).map(([key, value]) => [key, {
  nodes: value.nodes,
  allocatable: compactResources(value.cpu, value.memory),
  maxSingleNodeFree: compactResources(maxSingleNodeFree[key].cpu, maxSingleNodeFree[key].memory),
}]));
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
}).filter(Boolean).sort((left, right) => left.component.localeCompare(right.component));

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
})).sort((left, right) => left.name.localeCompare(right.name));
const smokeReleaseValues = readOptionalJson("smoke-release-values.json");
const allHelmReleases = readJson("helm-releases.json", []).filter((release) => release.namespace === process.env.ASKLAKE_EKS_NAMESPACE);
const smokeRelease = allHelmReleases.find((release) => release.name === "asklake-day17-nodepool-smoke");
const smokeReleaseOwned = Boolean(smokeRelease && smokeReleaseValues?.runFingerprint === fingerprint);
const helmReleases = allHelmReleases.filter((release) => release.name !== "asklake-day17-nodepool-smoke" || !smokeReleaseOwned).map((release) => ({
  name: release.name,
  revision: Number(release.revision),
  chart: release.chart,
  status: release.status,
})).sort((a, b) => a.name.localeCompare(b.name));
const identities = {
  deployments: deployments.filter((deployment) => !owned(deployment)).map((deployment) => ({ name: deployment.metadata?.name, generation: deployment.metadata?.generation ?? 0 })).sort((a, b) => a.name.localeCompare(b.name)),
  hpas: hpas.map(({ currentReplicas: _current, desiredReplicas: _desired, ...identity }) => identity),
  helmReleases,
};
const identityHash = createHash("sha256").update(JSON.stringify(identities)).digest("hex").slice(0, 16);

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
  unexpectedSmokeRelease: smokeRelease && !smokeReleaseOwned ? 1 : 0,
};
const controlledResources = {
  deploymentsTotal: deployments.filter(owned).length,
  podsTotal: pods.filter(owned).length,
  jobsTotal: jobs.filter(owned).length,
  sparkApplicationsTotal: sparkApplications.filter(owned).length,
  helmReleasesTotal: smokeReleaseOwned ? 1 : 0,
  activeJobs: activeJobs.filter(owned).length,
  activeSparkApplications: activeSpark.filter(owned).length,
  nonTerminalPods: nonTerminalPods.filter(owned).length,
};
const controlledUids = new Set([...deployments, ...pods, ...jobs, ...sparkApplications].filter(owned).map((resource) => resource.metadata?.uid).filter(Boolean));
const controlledComponentByUid = new Map([...deployments, ...pods, ...jobs, ...sparkApplications].filter(owned).map((resource) => {
  const name = resource.metadata?.name ?? "";
  const component = name.startsWith("asklake-day17-general-scale") ? "general-positive" :
    name.startsWith("asklake-day17-spark-scale") ? "spark-positive" :
      name === "asklake-day17-spark-negative" ? "spark-negative" : "other-controlled";
  return [resource.metadata?.uid, component];
}).filter(([uid]) => uid));
const controlledEventMap = items("events.json").filter((event) => controlledUids.has(event.involvedObject?.uid)).reduce((counts, event) => {
  const component = controlledComponentByUid.get(event.involvedObject?.uid) ?? "other-controlled";
  const reason = event.reason ?? "Unknown";
  const key = `${component}:${reason}`;
  counts[key] = (counts[key] ?? 0) + Number(event.count ?? 1);
  return counts;
}, {});
const controlledEvents = Object.entries(controlledEventMap).sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => {
  const [component, reason] = key.split(":");
  return { component, reason, count };
});
const negativePodUid = pods.find((pod) => owned(pod) && pod.metadata?.name === "asklake-day17-spark-negative")?.metadata?.uid;
const negativePod = pods.find((pod) => pod.metadata?.uid === negativePodUid);
const negativeSelectsSpark = negativePod?.spec?.nodeSelector?.["asklake.io/workload-class"] === "spark";
const negativeLacksSparkToleration = !(negativePod?.spec?.tolerations ?? []).some((entry) =>
  entry.key === "asklake.io/workload-class" && entry.value === "spark" && entry.effect === "NoSchedule");
const sparkNodeHasExactTaint = nodes.some((node) =>
  node.metadata?.labels?.["karpenter.sh/nodepool"] === "asklake-spark" &&
  (node.spec?.taints ?? []).some((taint) => taint.key === "asklake.io/workload-class" && taint.value === "spark" && taint.effect === "NoSchedule"));
const untoleratedEventObserved = Boolean(negativePodUid && items("events.json").some((event) =>
  event.involvedObject?.uid === negativePodUid &&
  event.reason === "FailedScheduling" &&
  /untolerated taint/i.test(event.message ?? "")));
const untoleratedSparkTaintObserved = Boolean(
  negativeSelectsSpark && negativeLacksSparkToleration && pools.spark.live?.sparkTaint && sparkNodeHasExactTaint && untoleratedEventObserved);
const transitionProof = readOptionalJson("transition-proof.json");
if (transitionProof && transitionProof.runFingerprint !== fingerprint) throw new Error("transition proof run fingerprint mismatch");
const sanitizePoolProof = (proof) => {
  if (!proof) return null;
  const result = {};
  for (const key of ["pendingObserved", "newNodeObserved", "scheduledOnNewNode", "runningObserved"]) {
    if (typeof proof[key] !== "boolean") throw new Error("transition proof must contain boolean assertions only");
    result[key] = proof[key];
  }
  return result;
};
const sanitizedTransitionProof = transitionProof ? {
  general: sanitizePoolProof(transitionProof.general),
  spark: sanitizePoolProof(transitionProof.spark),
} : null;
if (sanitizedTransitionProof && phase === "sample") {
  for (const pool of ["general", "spark"]) {
    const positivePod = pods.find((pod) => owned(pod) && pod.metadata?.name?.startsWith(`asklake-day17-${pool}-scale-`));
    const scheduledPool = nodePoolByName.get(positivePod?.spec?.nodeName);
    const ready = positivePod?.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True");
    if (!positivePod || positivePod.status?.phase !== "Running" || !ready || scheduledPool !== `asklake-${pool}`) {
      throw new Error("transition proof is not corroborated by a controlled Running Pod");
    }
  }
}
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
  controlledEvents,
  untoleratedSparkTaintObserved,
  transitionProof: sanitizedTransitionProof,
  gates: { poolReady, placementReady, exclusiveWindowReady },
};
if (phase === "baseline") {
  evidence = { contractVersion: "1.0", scope, runFingerprint: fingerprint, labelContract: `${labelKey}=<run-fingerprint>`, baselineIdentityHash: identityHash, snapshots: [snapshot], cleanup: { verified: false } };
} else {
  if (evidence.scope !== scope) throw new Error("observation scope does not match the existing evidence");
  snapshot.identityMatchesBaseline = identityHash === evidence.baselineIdentityHash;
  snapshot.gates.identityMatchesBaseline = snapshot.identityMatchesBaseline;
  evidence.snapshots.push(snapshot);
  if (phase === "final") {
    evidence.cleanup = {
      verified: Object.values(controlledResources).every((count) => count === 0),
      controlledResources,
      verifiedAt: new Date().toISOString(),
    };
    const baseline = evidence.snapshots[0];
    const peak = (pool) => Math.max(...evidence.snapshots.map((entry) => entry.capacity?.[pool]?.nodes ?? 0));
    evidence.scaleTransitions = Object.fromEntries(["general", "spark"].map((pool) => [pool, {
      scaleOutObserved: peak(pool) > (baseline.capacity?.[pool]?.nodes ?? 0),
      scaleInObserved: (snapshot.capacity?.[pool]?.nodes ?? 0) <= (baseline.capacity?.[pool]?.nodes ?? 0),
    }]));
    const scaleTransitionsPassed = Object.values(evidence.scaleTransitions).every((transition) => transition.scaleOutObserved && transition.scaleInObserved);
    const isolatedTransitionProof = [...evidence.snapshots].reverse().find((entry) => entry.transitionProof)?.transitionProof;
    const isolatedPlacementPassed = ["general", "spark"].every((pool) => {
      const proof = isolatedTransitionProof?.[pool];
      return proof?.pendingObserved === true && proof?.newNodeObserved === true && proof?.scheduledOnNewNode === true && proof?.runningObserved === true;
    });
    const exactNegativeTaintPassed = evidence.snapshots.some((entry) => entry.untoleratedSparkTaintObserved === true);
    const scopeGate = scope === "isolated" ? true : placementReady;
    const isolatedGate = scope === "isolated" ? isolatedPlacementPassed && exactNegativeTaintPassed : true;
    evidence.finalGatePassed = evidence.cleanup.verified && snapshot.identityMatchesBaseline && poolReady && scopeGate && exclusiveWindowReady && scaleTransitionsPassed && isolatedGate;
  }
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
