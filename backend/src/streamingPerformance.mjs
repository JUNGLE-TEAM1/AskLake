import { createHash } from "node:crypto";

export const STREAMING_PLAN_SCHEMA = "asklake.streaming-test-plan.v1";
export const STREAMING_PROFILE_SCHEMA = "asklake.streaming-slo-profile.v1";
export const STREAMING_EVIDENCE_SCHEMA = "asklake.streaming-performance-evidence.v1";
export const STREAMING_REPORT_SCHEMA = "asklake.streaming-performance-report.v1";

const requiredLoadScenarios = Object.freeze(new Set([
  "small-steady",
  "ramp",
  "burst",
  "backlog",
  "capacity-cap",
  "scale-down",
  "multi-continuous",
  "continuous-with-batch",
]));

const requiredFaultScenarios = Object.freeze(new Set([
  "kafka-disconnect",
  "s3-write-failure",
  "schema-quarantine-surge",
  "emr-job-failure",
  "backend-restart",
  "checkpoint-permission",
  "invalid-authentication",
  "poison-records",
]));

const thresholdDefinitions = Object.freeze({
  minAverageThroughputRowsPerSecond: { metric: "averageThroughputRowsPerSecond", direction: "min", unit: "rows/s" },
  minQuarantineRatio: { metric: "quarantineRatio", direction: "min", unit: "ratio" },
  maxP95EndToEndLatencyMs: { metric: "p95EndToEndLatencyMs", direction: "max", unit: "ms" },
  maxBacklogRecoverySeconds: { metric: "backlogRecoverySeconds", direction: "max", unit: "seconds" },
  maxFaultRecoverySeconds: { metric: "faultRecoverySeconds", direction: "max", unit: "seconds" },
  maxFinalLag: { metric: "finalLag", direction: "max", unit: "records" },
  maxQuarantineRatio: { metric: "quarantineRatio", direction: "max", unit: "ratio" },
  maxCostUsd: { metric: "costUsd", direction: "max", unit: "USD" },
  maxSmallFileRatio: { metric: "smallFileRatio", direction: "max", unit: "ratio" },
});

const requiredEvidenceNames = Object.freeze(new Set([
  "latencyPercentiles",
  "billedResourceUtilization",
  "cloudWatchMetrics",
  "outputFileMetrics",
  "actualCost",
]));
const terminalFaultScenarios = Object.freeze(new Set([
  "emr-job-failure",
  "checkpoint-permission",
  "invalid-authentication",
]));

const forbiddenEvidenceKeys = /(?:authorization|bootstrap(?:Servers?|Brokers?)?|credential|endpoint|password|secret|sessionToken|token)$/i;

export function validateStreamingPlan(plan) {
  assertObject(plan, "streaming test plan");
  assertEqual(plan.schemaVersion, STREAMING_PLAN_SCHEMA, "streaming test plan schemaVersion");
  assertSafeIdentifier(plan.planId, "planId");
  assertSafeIdentifier(plan.namespacePrefix, "namespacePrefix");
  assertObject(plan.safety, "plan safety");
  if (plan.safety.requiresExplicitOptIn !== true) {
    throw new Error("Streaming test plan must require explicit opt-in.");
  }
  if (plan.safety.dedicatedEnvironment !== true) {
    throw new Error("Streaming test plan must require a dedicated environment.");
  }
  if (plan.safety.allowDestructiveCleanup !== false) {
    throw new Error("Streaming test plan must disable destructive shared-resource cleanup.");
  }
  validateScenarioCollection(plan.loadScenarios, requiredLoadScenarios, "loadScenarios");
  validateScenarioCollection(plan.faultScenarios, requiredFaultScenarios, "faultScenarios");
  return plan;
}

export function validateStreamingProfile(profile) {
  assertObject(profile, "streaming SLO profile");
  assertEqual(profile.schemaVersion, STREAMING_PROFILE_SCHEMA, "streaming SLO profile schemaVersion");
  assertSafeIdentifier(profile.profileId, "profileId");
  if (!["draft", "approved"].includes(profile.approvalStatus)) {
    throw new Error("approvalStatus must be draft or approved.");
  }
  assertNonEmptyText(profile.environment, "environment");
  assertNonEmptyText(profile.region, "region");
  assertEqual(profile.currency, "USD", "currency");
  positiveInteger(profile.minimumSuccessfulRuns, "minimumSuccessfulRuns");
  assertObject(profile.requiredEvidence, "requiredEvidence");
  for (const [name, required] of Object.entries(profile.requiredEvidence)) {
    if (!requiredEvidenceNames.has(name)) throw new Error(`Unsupported required evidence: ${name}`);
    if (typeof required !== "boolean") throw new Error(`requiredEvidence.${name} must be boolean.`);
  }
  assertObject(profile.scenarioThresholds, "scenarioThresholds");
  for (const [scenarioId, thresholds] of Object.entries(profile.scenarioThresholds)) {
    assertSafeIdentifier(scenarioId, "scenarioThresholds key");
    assertObject(thresholds, `scenarioThresholds.${scenarioId}`);
    if (!Object.keys(thresholds).length) {
      throw new Error(`scenarioThresholds.${scenarioId} must define at least one threshold.`);
    }
    for (const [name, value] of Object.entries(thresholds)) {
      if (!thresholdDefinitions[name]) throw new Error(`Unsupported performance threshold: ${name}`);
      if (value !== null) nonNegativeNumber(value, `scenarioThresholds.${scenarioId}.${name}`);
      if ((name === "minQuarantineRatio" || name === "maxQuarantineRatio" || name === "maxSmallFileRatio") && value !== null && value > 1) {
        throw new Error(`${name} must be between 0 and 1.`);
      }
    }
  }
  if (profile.approvalStatus === "approved") {
    assertNonEmptyText(profile.approvedBy, "approvedBy");
    isoTimestamp(profile.approvedAt, "approvedAt");
    for (const [scenarioId, thresholds] of Object.entries(profile.scenarioThresholds)) {
      for (const [name, value] of Object.entries(thresholds)) {
        if (value === null) throw new Error(`Approved profile threshold cannot be null: ${scenarioId}.${name}`);
      }
    }
  }
  return profile;
}

export function normalizeStreamingEvidence(evidence) {
  assertObject(evidence, "streaming performance evidence");
  assertEqual(evidence.schemaVersion, STREAMING_EVIDENCE_SCHEMA, "streaming evidence schemaVersion");
  assertSafeIdentifier(evidence.runId, "runId");
  assertSafeIdentifier(evidence.scenarioId, "scenarioId");
  if (!["local-docker", "emr-serverless"].includes(evidence.runtime)) {
    throw new Error("runtime must be local-docker or emr-serverless.");
  }
  const startedAt = isoTimestamp(evidence.startedAt, "startedAt");
  const completedAt = isoTimestamp(evidence.completedAt, "completedAt");
  if (completedAt < startedAt) throw new Error("completedAt must not be earlier than startedAt.");
  assertObject(evidence.environment, "environment evidence");
  assertNonEmptyText(evidence.environment.name, "environment.name");
  assertNonEmptyText(evidence.environment.region, "environment.region");
  assertNonEmptyText(evidence.environment.sourceRevision, "environment.sourceRevision");
  assertObject(evidence.tuning, "tuning evidence");
  assertObject(evidence.counts, "count evidence");
  assertNoSensitiveKeys(evidence);

  const counts = normalizeCounts(evidence.counts);
  const durationSeconds = Math.max((completedAt - startedAt) / 1000, 0.001);
  const throughputSamples = numericArray(evidence.throughputSamplesRowsPerSecond, "throughputSamplesRowsPerSecond");
  const lagSamples = numericArray(evidence.lagSamples, "lagSamples");
  const executorSamples = numericArray(evidence.executorSamples, "executorSamples");
  const latency = normalizeLatency(evidence.latency);
  const fault = normalizeFault(evidence.fault, evidence.scenarioId);
  const recovery = normalizeRecovery(evidence.recovery);
  const output = normalizeOutput(evidence.output);
  const resources = normalizeResources(evidence.resources, executorSamples);
  const cost = normalizeCost(evidence.cost, evidence.emrJobRun, evidence.environment.region);
  const averageThroughput = finiteOrNull(evidence.averageThroughputRowsPerSecond)
    ?? round(counts.consumed / durationSeconds, 3);
  const finalLag = lagSamples.length
    ? lagSamples.at(-1)
    : finiteOrNull(evidence.finalLag);
  const peakLag = lagSamples.length
    ? Math.max(...lagSamples)
    : finiteOrNull(evidence.peakLag);

  return {
    ...evidence,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    counts,
    durationSeconds: round(durationSeconds, 3),
    metrics: {
      averageThroughputRowsPerSecond: averageThroughput,
      peakThroughputRowsPerSecond: throughputSamples.length ? Math.max(...throughputSamples) : averageThroughput,
      p50EndToEndLatencyMs: latency?.p50Ms ?? null,
      p95EndToEndLatencyMs: latency?.p95Ms ?? null,
      p99EndToEndLatencyMs: latency?.p99Ms ?? null,
      latencySampleCount: latency?.sampleCount ?? 0,
      peakLag,
      finalLag,
      backlogRecoverySeconds: recovery.backlogRecoverySeconds,
      faultRecoverySeconds: recovery.faultRecoverySeconds,
      quarantineRatio: counts.produced ? round(counts.quarantined / counts.produced, 6) : 0,
      smallFileRatio: output.fileCount ? round(output.smallFileCount / output.fileCount, 6) : null,
      costUsd: cost.actualCostUsd ?? cost.estimatedCostUsd,
    },
    latency,
    fault,
    recovery,
    output,
    resources,
    cost,
    configurationFingerprint: evidence.configurationFingerprint || configurationFingerprint(evidence),
  };
}

export function evaluateStreamingEvidence(profileValue, evidenceValue) {
  const profile = validateStreamingProfile(profileValue);
  const evidence = normalizeStreamingEvidence(evidenceValue);
  const thresholds = profile.scenarioThresholds[evidence.scenarioId];
  const gates = [];
  gates.push(gate(
    "operational-evidence",
    evidence.exampleOnly === true ? "insufficient-evidence" : "passed",
    evidence.exampleOnly === true ? "example" : "operational",
    "operational",
    "Checked-in example evidence cannot approve a real performance campaign.",
  ));
  addIntegrityGates(gates, evidence.counts);
  addLatencyIntegrityGates(gates, evidence);
  addEnvironmentGates(gates, profile, evidence);
  addFaultScenarioGates(gates, evidence);
  addRequiredEvidenceGates(gates, profile, evidence);

  if (!thresholds) {
    gates.push(gate("scenario-profile", "insufficient-evidence", null, null, "No threshold set exists for this scenario."));
  } else {
    for (const [thresholdName, target] of Object.entries(thresholds)) {
      const definition = thresholdDefinitions[thresholdName];
      const actual = evidence.metrics[definition.metric];
      if (target === null) {
        gates.push(gate(thresholdName, "insufficient-evidence", actual, target, "The SLO threshold is not approved."));
      } else if (!Number.isFinite(actual)) {
        gates.push(gate(thresholdName, "insufficient-evidence", actual, target, `${definition.metric} is missing.`));
      } else {
        const passed = definition.direction === "min" ? actual >= target : actual <= target;
        gates.push(gate(
          thresholdName,
          passed ? "passed" : "failed",
          actual,
          target,
          `${definition.metric} ${definition.direction === "min" ? ">=" : "<="} ${target} ${definition.unit}`,
        ));
      }
    }
  }
  if (profile.approvalStatus !== "approved") {
    gates.push(gate("profile-approval", "insufficient-evidence", profile.approvalStatus, "approved", "Draft SLO profiles cannot approve performance."));
  }
  return {
    runId: evidence.runId,
    scenarioId: evidence.scenarioId,
    evidenceKind: evidence.exampleOnly === true ? "example" : "operational",
    status: overallStatus(gates.map((item) => item.status)),
    configurationFingerprint: evidence.configurationFingerprint,
    metrics: evidence.metrics,
    counts: evidence.counts,
    fault: evidence.fault,
    resources: evidence.resources,
    output: evidence.output,
    cost: evidence.cost,
    gates,
  };
}

export function evaluateStreamingCampaign(profileValue, evidenceValues) {
  const profile = validateStreamingProfile(profileValue);
  if (!Array.isArray(evidenceValues) || !evidenceValues.length) {
    throw new Error("At least one streaming evidence document is required.");
  }
  const evaluations = evidenceValues.map((evidence) => evaluateStreamingEvidence(profile, evidence));
  const grouped = new Map();
  for (const evaluation of evaluations) {
    const items = grouped.get(evaluation.scenarioId) || [];
    items.push(evaluation);
    grouped.set(evaluation.scenarioId, items);
  }
  for (const scenarioId of Object.keys(profile.scenarioThresholds)) {
    if (!grouped.has(scenarioId)) grouped.set(scenarioId, []);
  }
  const scenarios = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([scenarioId, runs]) => {
    const fingerprints = [...new Set(runs.map((run) => run.configurationFingerprint))];
    const uniqueRunIds = new Set(runs.map((run) => run.runId));
    const gates = [
      gate(
        "unique-run-identity",
        uniqueRunIds.size === runs.length ? "passed" : "failed",
        uniqueRunIds.size,
        runs.length,
        "The same evidence run cannot be counted more than once.",
      ),
      gate(
        "repeat-count",
        runs.length >= profile.minimumSuccessfulRuns ? "passed" : "insufficient-evidence",
        runs.length,
        profile.minimumSuccessfulRuns,
        "Each scenario needs enough repeated runs before approval.",
      ),
      gate(
        "comparable-configuration",
        runs.length === 0 ? "insufficient-evidence" : fingerprints.length === 1 ? "passed" : "failed",
        fingerprints.length,
        1,
        "Repeated runs must use the same workload and tuning configuration.",
      ),
    ];
    const runStatus = runs.length ? overallStatus(runs.map((run) => run.status)) : "insufficient-evidence";
    gates.push(gate("run-evaluations", runStatus, runStatus, "passed", "All repeated runs must pass."));
    return {
      scenarioId,
      status: overallStatus(gates.map((item) => item.status)),
      runCount: runs.length,
      configurationFingerprints: fingerprints,
      summary: summarizeRuns(runs),
      gates,
      runs,
    };
  });
  return {
    schemaVersion: STREAMING_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    evidenceKind: evaluations.every((evaluation) => evaluation.evidenceKind === "operational") ? "operational" : "example",
    scenarioCoverage: {
      requiredScenarioIds: Object.keys(profile.scenarioThresholds).sort(),
      missingScenarioIds: Object.keys(profile.scenarioThresholds).filter((scenarioId) => !evaluations.some((evaluation) => evaluation.scenarioId === scenarioId)).sort(),
    },
    profile: {
      profileId: profile.profileId,
      approvalStatus: profile.approvalStatus,
      approvedBy: profile.approvedBy || null,
      approvedAt: profile.approvedAt || null,
      environment: profile.environment,
      region: profile.region,
      currency: profile.currency,
      minimumSuccessfulRuns: profile.minimumSuccessfulRuns,
    },
    status: overallStatus(scenarios.map((scenario) => scenario.status)),
    scenarios,
  };
}

export function renderStreamingCampaignMarkdown(report) {
  assertEqual(report?.schemaVersion, STREAMING_REPORT_SCHEMA, "streaming report schemaVersion");
  const lines = [
    "# Kafka·Spark Phase 7 성능 검증 리포트",
    "",
    `- 생성 시각: ${report.generatedAt}`,
    `- SLO profile: ${report.profile.profileId} (${report.profile.approvalStatus})`,
    `- 승인자/시각: ${report.profile.approvedBy || "-"} / ${report.profile.approvedAt || "-"}`,
    `- 환경/region: ${report.profile.environment} / ${report.profile.region}`,
    `- 최종 판정: **${report.status}**`,
    "",
    "## 시나리오 요약",
    "",
    "| 시나리오 | 반복 | 판정 | 평균 처리량 median | P95 worst | 최종 lag worst | 비용 worst |",
    "|---|---:|---|---:|---:|---:|---:|",
  ];
  for (const scenario of report.scenarios) {
    lines.push(`| ${escapeTable(scenario.scenarioId)} | ${scenario.runCount} | ${scenario.status} | ${display(scenario.summary.averageThroughputRowsPerSecondMedian)} | ${display(scenario.summary.p95EndToEndLatencyMsWorst)} | ${display(scenario.summary.finalLagWorst)} | ${display(scenario.summary.costUsdWorst)} |`);
  }
  for (const scenario of report.scenarios) {
    lines.push("", `## ${scenario.scenarioId}`, "", "### 반복 실행", "", "| Run | 판정 | 입력/소비/저장/격리 | 누락 | 중복 | P95 ms | 비용 USD |", "|---|---|---|---:|---:|---:|---:|");
    for (const run of scenario.runs) {
      lines.push(`| ${escapeTable(run.runId)} | ${run.status} | ${run.counts.produced}/${run.counts.consumed}/${run.counts.stored}/${run.counts.quarantined} | ${run.counts.missing} | ${run.counts.unexplainedDuplicates} | ${display(run.metrics.p95EndToEndLatencyMs)} | ${display(run.metrics.costUsd)} |`);
    }
    lines.push("", "### 판정 근거", "", "| Gate | 상태 | 실제 | 기준 | 설명 |", "|---|---|---:|---:|---|");
    for (const item of scenario.gates) {
      lines.push(`| ${escapeTable(`campaign:${item.name}`)} | ${item.status} | ${display(item.actual)} | ${display(item.target)} | ${escapeTable(item.detail)} |`);
    }
    for (const run of scenario.runs) {
      for (const item of run.gates) {
        lines.push(`| ${escapeTable(`${run.runId}:${item.name}`)} | ${item.status} | ${display(item.actual)} | ${display(item.target)} | ${escapeTable(item.detail)} |`);
      }
    }
  }
  lines.push(
    "",
    "> `insufficient-evidence`는 성공이 아니다. SLO 승인, 반복 수, latency, CloudWatch, EMR billed resource 또는 비용 근거가 빠진 상태를 뜻한다.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function redactStreamingEvidence(value) {
  if (Array.isArray(value)) return value.map(redactStreamingEvidence);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = forbiddenEvidenceKeys.test(key) ? "[REDACTED]" : redactStreamingEvidence(child);
  }
  return result;
}

function validateScenarioCollection(items, required, field) {
  if (!Array.isArray(items)) throw new Error(`${field} must be an array.`);
  const ids = new Set();
  for (const item of items) {
    assertObject(item, `${field} item`);
    assertSafeIdentifier(item.id, `${field}.id`);
    if (ids.has(item.id)) throw new Error(`${field} contains duplicate id: ${item.id}`);
    ids.add(item.id);
    if (!["local-soak", "aws-staging"].includes(item.executor)) {
      throw new Error(`${field}.${item.id}.executor must be local-soak or aws-staging.`);
    }
    if (!Array.isArray(item.recordedMetrics) || !item.recordedMetrics.length) {
      throw new Error(`${field}.${item.id}.recordedMetrics must be non-empty.`);
    }
  }
  for (const id of required) {
    if (!ids.has(id)) throw new Error(`${field} is missing required scenario: ${id}`);
  }
}

function normalizeCounts(value) {
  const counts = {};
  for (const name of ["produced", "consumed", "stored", "quarantined", "replayed", "failed"]) {
    counts[name] = nonNegativeInteger(value[name] ?? 0, `counts.${name}`);
  }
  const explained = counts.stored + counts.quarantined - counts.replayed;
  counts.missing = value.missing === undefined
    ? Math.max(counts.produced - explained, 0)
    : nonNegativeInteger(value.missing, "counts.missing");
  counts.unexplainedDuplicates = value.unexplainedDuplicates === undefined
    ? Math.max(explained - counts.produced, 0)
    : nonNegativeInteger(value.unexplainedDuplicates, "counts.unexplainedDuplicates");
  return counts;
}

function normalizeLatency(value) {
  if (value === null || value === undefined) return null;
  assertObject(value, "latency evidence");
  const aggregation = value.aggregation ?? null;
  if (aggregation !== null && aggregation !== "worst-successful-batch-percentile") {
    throw new Error("latency.aggregation must be worst-successful-batch-percentile when present.");
  }
  const batchCount = value.batchCount === null || value.batchCount === undefined
    ? null
    : nonNegativeInteger(value.batchCount, "latency.batchCount");
  const sampleCount = nonNegativeInteger(value.sampleCount ?? 0, "latency.sampleCount");
  const timestampMissingCount = nonNegativeInteger(value.timestampMissingCount ?? 0, "latency.timestampMissingCount");
  const p50Ms = finiteOrNull(value.p50Ms);
  const p95Ms = finiteOrNull(value.p95Ms);
  const p99Ms = finiteOrNull(value.p99Ms);
  for (const [name, number] of Object.entries({ p50Ms, p95Ms, p99Ms })) {
    if (number !== null) nonNegativeNumber(number, `latency.${name}`);
  }
  if ([p50Ms, p95Ms, p99Ms].every(Number.isFinite) && !(p50Ms <= p95Ms && p95Ms <= p99Ms)) {
    throw new Error("Latency percentiles must satisfy p50 <= p95 <= p99.");
  }
  assertEqual(value.method, "kafka-record-timestamp-to-target-commit", "latency.method");
  if (sampleCount > 0 && aggregation !== "worst-successful-batch-percentile") {
    throw new Error("Measured latency evidence requires worst-successful-batch-percentile aggregation.");
  }
  if (sampleCount > 0 && (!Number.isSafeInteger(batchCount) || batchCount <= 0)) {
    throw new Error("Measured latency evidence requires a positive latency.batchCount.");
  }
  return { aggregation, batchCount, sampleCount, timestampMissingCount, p50Ms, p95Ms, p99Ms, method: value.method };
}

function normalizeRecovery(value) {
  if (value === null || value === undefined) return { backlogRecoverySeconds: null, faultRecoverySeconds: null };
  assertObject(value, "recovery evidence");
  const backlogRecoverySeconds = finiteOrNull(value.backlogRecoverySeconds);
  const faultRecoverySeconds = finiteOrNull(value.faultRecoverySeconds);
  if (backlogRecoverySeconds !== null) nonNegativeNumber(backlogRecoverySeconds, "recovery.backlogRecoverySeconds");
  if (faultRecoverySeconds !== null) nonNegativeNumber(faultRecoverySeconds, "recovery.faultRecoverySeconds");
  return { backlogRecoverySeconds, faultRecoverySeconds };
}

function normalizeFault(value, scenarioId) {
  if (value === null || value === undefined) return null;
  assertObject(value, "fault evidence");
  const injection = String(value.injection || "").trim();
  assertNonEmptyText(injection, "fault.injection");
  if (injection !== scenarioId) throw new Error("fault.injection must match scenarioId.");
  return {
    injection,
    injected: booleanOrNull(value.injected, "fault.injected"),
    expectedOutcomeObserved: booleanOrNull(value.expectedOutcomeObserved, "fault.expectedOutcomeObserved"),
    recovered: booleanOrNull(value.recovered, "fault.recovered"),
    failureCode: value.failureCode === null || value.failureCode === undefined
      ? null
      : singleLineOrNull(value.failureCode, "fault.failureCode"),
  };
}

function normalizeOutput(value) {
  if (value === null || value === undefined) return { bytes: null, fileCount: null, smallFileCount: null, smallFileThresholdBytes: null };
  assertObject(value, "output evidence");
  const result = {};
  for (const name of ["bytes", "fileCount", "smallFileCount", "smallFileThresholdBytes"]) {
    result[name] = value[name] === null || value[name] === undefined ? null : nonNegativeInteger(value[name], `output.${name}`);
  }
  if (Number.isFinite(result.fileCount) && Number.isFinite(result.smallFileCount) && result.smallFileCount > result.fileCount) {
    throw new Error("output.smallFileCount must not exceed output.fileCount.");
  }
  return result;
}

function normalizeResources(value, executorSamples) {
  const source = value && typeof value === "object" ? value : {};
  return {
    executorMin: executorSamples.length ? Math.min(...executorSamples) : finiteOrNull(source.executorMin),
    executorMax: executorSamples.length ? Math.max(...executorSamples) : finiteOrNull(source.executorMax),
    executorAverage: executorSamples.length ? round(average(executorSamples), 3) : finiteOrNull(source.executorAverage),
    peakCpuVcpu: finiteOrNull(source.peakCpuVcpu),
    peakMemoryGb: finiteOrNull(source.peakMemoryGb),
    cloudWatchMetricPeriodSeconds: finiteOrNull(source.cloudWatchMetricPeriodSeconds),
  };
}

function normalizeCost(value, emrJobRun, evidenceRegion) {
  const source = value && typeof value === "object" ? value : {};
  const actualCostUsd = finiteOrNull(source.actualCostUsd);
  if (actualCostUsd !== null) nonNegativeNumber(actualCostUsd, "cost.actualCostUsd");
  const additional = nonNegativeNumber(source.additionalCostUsd ?? 0, "cost.additionalCostUsd");
  const billedSource = emrJobRun?.billedResourceUtilization;
  const billed = billedSource ? {
    vCPUHour: nonNegativeNumber(billedSource.vCPUHour, "billedResourceUtilization.vCPUHour"),
    memoryGBHour: nonNegativeNumber(billedSource.memoryGBHour, "billedResourceUtilization.memoryGBHour"),
    storageGBHour: nonNegativeNumber(billedSource.storageGBHour, "billedResourceUtilization.storageGBHour"),
  } : null;
  const price = source.priceSnapshot;
  let estimatedCostUsd = null;
  let normalizedPrice = null;
  if (price) {
    assertObject(price, "cost.priceSnapshot");
    assertEqual(price.currency, "USD", "cost.priceSnapshot.currency");
    isoTimestamp(price.effectiveAt, "cost.priceSnapshot.effectiveAt");
    assertNonEmptyText(price.region, "cost.priceSnapshot.region");
    assertEqual(price.region, evidenceRegion, "cost.priceSnapshot.region");
    assertNonEmptyText(price.architecture, "cost.priceSnapshot.architecture");
    officialAwsUrl(price.sourceUrl, "cost.priceSnapshot.sourceUrl");
    const vcpuRate = nonNegativeNumber(price.vCPUHourUsd, "priceSnapshot.vCPUHourUsd");
    const memoryRate = nonNegativeNumber(price.memoryGBHourUsd, "priceSnapshot.memoryGBHourUsd");
    const storageRate = nonNegativeNumber(price.storageGBHourUsd, "priceSnapshot.storageGBHourUsd");
    normalizedPrice = { ...price, vCPUHourUsd: vcpuRate, memoryGBHourUsd: memoryRate, storageGBHourUsd: storageRate };
  }
  if (billed && normalizedPrice) {
    estimatedCostUsd = round(
      (billed.vCPUHour * normalizedPrice.vCPUHourUsd)
      + (billed.memoryGBHour * normalizedPrice.memoryGBHourUsd)
      + (billed.storageGBHour * normalizedPrice.storageGBHourUsd)
      + additional,
      6,
    );
  }
  return {
    actualCostUsd,
    estimatedCostUsd,
    billedResourceUtilization: billed || null,
    priceSnapshot: normalizedPrice,
  };
}

function addIntegrityGates(gates, counts) {
  gates.push(gate("produced-consumed", counts.produced === counts.consumed ? "passed" : "failed", counts.consumed, counts.produced, "Every produced record must be consumed."));
  gates.push(gate("missing-records", counts.missing === 0 ? "passed" : "failed", counts.missing, 0, "Missing records are never accepted."));
  gates.push(gate("unexplained-duplicates", counts.unexplainedDuplicates === 0 ? "passed" : "failed", counts.unexplainedDuplicates, 0, "Unexplained duplicates are never accepted."));
  const reconciled = counts.stored + counts.quarantined - counts.replayed;
  gates.push(gate("sink-reconciliation", reconciled === counts.consumed ? "passed" : "failed", reconciled, counts.consumed, "stored + quarantined - replayed must equal consumed."));
}

function addLatencyIntegrityGates(gates, evidence) {
  if (!evidence.latency) return;
  const covered = evidence.latency.sampleCount + evidence.latency.timestampMissingCount;
  gates.push(gate(
    "latency-coverage",
    covered === evidence.counts.consumed ? "passed" : "failed",
    covered,
    evidence.counts.consumed,
    "Latency samples plus missing Kafka timestamps must cover every consumed record.",
  ));
}

function addEnvironmentGates(gates, profile, evidence) {
  gates.push(gate(
    "profile-environment",
    evidence.environment.name === profile.environment ? "passed" : "failed",
    evidence.environment.name,
    profile.environment,
    "Evidence must come from the approved environment.",
  ));
  gates.push(gate(
    "profile-region",
    evidence.environment.region === profile.region ? "passed" : "failed",
    evidence.environment.region,
    profile.region,
    "Evidence and the SLO profile must use the same region.",
  ));
}

function addFaultScenarioGates(gates, evidence) {
  if (!requiredFaultScenarios.has(evidence.scenarioId)) return;
  if (!evidence.fault) {
    gates.push(gate("fault-injected", "insufficient-evidence", null, true, "Fault scenarios require injection evidence."));
    gates.push(gate("fault-outcome", "insufficient-evidence", null, true, "Fault scenarios require the expected outcome evidence."));
    if (terminalFaultScenarios.has(evidence.scenarioId)) {
      gates.push(gate("fault-code", "insufficient-evidence", null, "non-empty", "This terminal fault requires a classified failure code."));
    }
    return;
  }
  gates.push(gate(
    "fault-injected",
    evidence.fault.injected === null ? "insufficient-evidence" : evidence.fault.injected ? "passed" : "failed",
    evidence.fault.injected,
    true,
    "The declared fault must actually be injected.",
  ));
  gates.push(gate(
    "fault-outcome",
    evidence.fault.expectedOutcomeObserved === null ? "insufficient-evidence" : evidence.fault.expectedOutcomeObserved ? "passed" : "failed",
    evidence.fault.expectedOutcomeObserved,
    true,
    "The scenario-specific expected outcome must be observed.",
  ));
  if (terminalFaultScenarios.has(evidence.scenarioId)) {
    gates.push(gate(
      "fault-code",
      evidence.fault.failureCode ? "passed" : "insufficient-evidence",
      evidence.fault.failureCode,
      "non-empty",
      "This terminal fault requires a classified failure code.",
    ));
  }
}

function addRequiredEvidenceGates(gates, profile, evidence) {
  const requirements = profile.requiredEvidence;
  const checks = {
    latencyPercentiles: Boolean(
      evidence.latency
      && evidence.latency.sampleCount > 0
      && evidence.latency.batchCount > 0
      && evidence.latency.aggregation === "worst-successful-batch-percentile"
      && [evidence.latency.p50Ms, evidence.latency.p95Ms, evidence.latency.p99Ms].every(Number.isFinite)
    ),
    billedResourceUtilization: Boolean(evidence.cost.billedResourceUtilization),
    cloudWatchMetrics: Boolean(
      evidence.executorSamples.length
      && evidence.resources.cloudWatchMetricPeriodSeconds > 0
      && Number.isFinite(evidence.resources.peakCpuVcpu)
      && Number.isFinite(evidence.resources.peakMemoryGb)
    ),
    outputFileMetrics: Number.isFinite(evidence.output.fileCount) && Number.isFinite(evidence.output.smallFileCount),
    actualCost: Number.isFinite(evidence.cost.actualCostUsd),
  };
  for (const [name, required] of Object.entries(requirements)) {
    if (required !== true) continue;
    gates.push(gate(`evidence:${name}`, checks[name] ? "passed" : "insufficient-evidence", checks[name], true, `${name} evidence is required by the profile.`));
  }
}

function configurationFingerprint(evidence) {
  return createHash("sha256").update(stableJson({
    environment: evidence.environment,
    runtime: evidence.runtime,
    scenarioId: evidence.scenarioId,
    faultInjection: evidence.fault?.injection || null,
    tuning: evidence.tuning,
    workload: evidence.workload || {},
  })).digest("hex");
}

function summarizeRuns(runs) {
  return {
    averageThroughputRowsPerSecondMedian: median(numericMetrics(runs, "averageThroughputRowsPerSecond")),
    p95EndToEndLatencyMsWorst: maximum(numericMetrics(runs, "p95EndToEndLatencyMs")),
    finalLagWorst: maximum(numericMetrics(runs, "finalLag")),
    backlogRecoverySecondsWorst: maximum(numericMetrics(runs, "backlogRecoverySeconds")),
    faultRecoverySecondsWorst: maximum(numericMetrics(runs, "faultRecoverySeconds")),
    costUsdWorst: maximum(numericMetrics(runs, "costUsd")),
  };
}

function numericMetrics(runs, name) {
  return runs.map((run) => run.metrics[name]).filter(Number.isFinite);
}

function overallStatus(statuses) {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("insufficient-evidence")) return "insufficient-evidence";
  return "passed";
}

function gate(name, status, actual, target, detail) {
  return { name, status, actual, target, detail };
}

function assertNoSensitiveKeys(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    if (redactSensitiveText(value) !== value) throw new Error(`Sensitive value is not allowed in performance evidence: ${path}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenEvidenceKeys.test(key)) throw new Error(`Sensitive key is not allowed in performance evidence: ${path}.${key}`);
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s|]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*[^\s|]+/gi, "[REDACTED]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:[0-9]{2,5}\b/g, "[ENDPOINT]");
}

function numericArray(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((item, index) => nonNegativeNumber(item, `${name}[${index}]`));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2, 6);
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name} must be ${expected}.`);
}

function assertSafeIdentifier(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value || ""))) {
    throw new Error(`${name} must be a safe identifier.`);
  }
}

function assertNonEmptyText(value, name) {
  if (!String(value || "").trim() || /[\r\n]/.test(String(value))) throw new Error(`${name} must be a non-empty single line.`);
}

function officialAwsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${name} must be an official AWS HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || (parsed.hostname !== "aws.amazon.com" && !parsed.hostname.endsWith(".aws.amazon.com"))) {
    throw new Error(`${name} must be an official AWS HTTPS URL.`);
  }
}

function isoTimestamp(value, name) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function booleanOrNull(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean or null.`);
  return value;
}

function singleLineOrNull(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  assertNonEmptyText(normalized, name);
  return normalized;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function escapeTable(value) {
  return String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function display(value) {
  if (value === null || value === undefined || value === "") return "-";
  return typeof value === "number" ? String(round(value, 6)) : escapeTable(value);
}
