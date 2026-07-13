import { createHash } from "node:crypto";

import { STREAMING_REPORT_SCHEMA } from "./streamingPerformance.mjs";

export const RUNTIME_CUTOVER_PLAN_SCHEMA = "asklake.runtime-cutover-plan.v1";
export const RUNTIME_CUTOVER_POLICY_SCHEMA = "asklake.runtime-cutover-policy.v1";
export const RUNTIME_CUTOVER_EVIDENCE_SCHEMA = "asklake.runtime-cutover-evidence.v1";
export const RUNTIME_CUTOVER_REPORT_SCHEMA = "asklake.runtime-cutover-report.v1";

const REQUIRED_STAGES = Object.freeze([
  "docker-regression",
  "aws-batch-staging",
  "aws-continuous-staging",
  "shadow-isolation",
  "result-comparison",
  "small-workload-cutover",
  "observation",
  "promotion-approval",
  "rollback-readiness",
]);
const EXPLICIT_STAGE_EVIDENCE = Object.freeze([
  "docker-regression",
  "aws-batch-staging",
  "aws-continuous-staging",
  "small-workload-cutover",
]);
const SPARK_RUNTIMES = Object.freeze(new Set(["spark-rest", "emr-serverless"]));
const KAFKA_RUNTIMES = Object.freeze(new Set(["redpanda", "msk"]));
const PHASE7_SCENARIOS = Object.freeze(new Set([
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
]));
const THRESHOLD_NAMES = Object.freeze([
  "maxStoredCountDelta",
  "maxQuarantineCountDelta",
  "maxErrorRate",
  "maxLag",
  "maxP95LatencyMs",
  "maxCostUsd",
]);
const FORBIDDEN_KEYS = /(?:authorization|bootstrap(?:Servers?|Brokers?)?|credential|endpoint|password|secret|sessionToken|token)$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;

export function validateRuntimeCutoverPlan(plan) {
  assertObject(plan, "runtime cutover plan");
  assertEqual(plan.schemaVersion, RUNTIME_CUTOVER_PLAN_SCHEMA, "runtime cutover plan schemaVersion");
  assertIdentifier(plan.planId, "planId");
  if (!Array.isArray(plan.stages) || plan.stages.length !== REQUIRED_STAGES.length) {
    throw new Error(`runtime cutover plan must define ${REQUIRED_STAGES.length} ordered stages.`);
  }
  assertDeepEqual(plan.stages, REQUIRED_STAGES, "runtime cutover plan stages");
  assertObject(plan.safety, "runtime cutover plan safety");
  for (const name of [
    "requireApprovedPhase7Report",
    "requireDistinctConsumerGroups",
    "requireDistinctOutputPrefixes",
    "requireDistinctCheckpoints",
    "requireExplicitPromotionApproval",
    "requireRollbackReadiness",
  ]) {
    assertEqual(plan.safety[name], true, `runtime cutover plan safety.${name}`);
  }
  assertEqual(plan.safety.allowAutomaticPromotion, false, "runtime cutover plan safety.allowAutomaticPromotion");
  assertObject(plan.defaultRuntime, "runtime cutover plan defaultRuntime");
  assertEqual(plan.defaultRuntime.sparkRuntime, "spark-rest", "runtime cutover default sparkRuntime");
  assertEqual(plan.defaultRuntime.kafkaRuntime, "redpanda", "runtime cutover default kafkaRuntime");
  return plan;
}

export function validateRuntimeCutoverPolicy(policy) {
  assertObject(policy, "runtime cutover policy");
  assertEqual(policy.schemaVersion, RUNTIME_CUTOVER_POLICY_SCHEMA, "runtime cutover policy schemaVersion");
  assertIdentifier(policy.policyId, "policyId");
  if (!["draft", "approved"].includes(policy.approvalStatus)) {
    throw new Error("runtime cutover policy approvalStatus must be draft or approved.");
  }
  assertText(policy.evidenceEnvironment, "evidenceEnvironment");
  assertObject(policy.target, "runtime cutover policy target");
  const target = normalizeTarget(policy.target);
  const minimumShadowRuns = nullablePositiveInteger(policy.minimumShadowRuns, "minimumShadowRuns");
  const minimumObservationMinutes = nullablePositiveNumber(policy.minimumObservationMinutes, "minimumObservationMinutes");
  assertObject(policy.thresholds, "runtime cutover policy thresholds");
  const thresholdKeys = Object.keys(policy.thresholds).sort();
  assertDeepEqual(thresholdKeys, [...THRESHOLD_NAMES].sort(), "runtime cutover policy threshold names");
  const thresholds = Object.fromEntries(THRESHOLD_NAMES.map((name) => [
    name,
    nullableNonNegativeNumber(policy.thresholds[name], `thresholds.${name}`),
  ]));
  for (const name of ["requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"]) {
    if (typeof policy[name] !== "boolean") throw new Error(`${name} must be boolean.`);
  }
  if (thresholds.maxErrorRate !== null && thresholds.maxErrorRate > 1) {
    throw new Error("thresholds.maxErrorRate must be between 0 and 1.");
  }
  if (policy.approvalStatus === "approved") {
    assertText(policy.approvedBy, "approvedBy");
    isoTimestamp(policy.approvedAt, "approvedAt");
    assertText(policy.changeTicket, "changeTicket");
    if (minimumShadowRuns === null || minimumObservationMinutes === null) {
      throw new Error("Approved runtime cutover policy requires shadow run and observation minimums.");
    }
    for (const [name, value] of Object.entries(thresholds)) {
      if (value === null) throw new Error(`Approved runtime cutover policy threshold cannot be null: ${name}`);
    }
    for (const name of ["requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"]) {
      if (policy[name] !== true) throw new Error(`Approved runtime cutover policy requires ${name}=true.`);
    }
  }
  return {
    ...policy,
    approvedAt: policy.approvedAt ? new Date(isoTimestamp(policy.approvedAt, "approvedAt")).toISOString() : null,
    target,
    minimumShadowRuns,
    minimumObservationMinutes,
    thresholds,
  };
}

export function normalizeRuntimeCutoverEvidence(evidence) {
  assertObject(evidence, "runtime cutover evidence");
  assertEqual(evidence.schemaVersion, RUNTIME_CUTOVER_EVIDENCE_SCHEMA, "runtime cutover evidence schemaVersion");
  assertIdentifier(evidence.campaignId, "campaignId");
  assertNoSensitiveEvidence(evidence);
  assertObject(evidence.environment, "runtime cutover environment");
  const environment = {
    name: singleLine(evidence.environment.name, "environment.name"),
    region: singleLine(evidence.environment.region, "environment.region"),
    sourceRevision: revision(evidence.environment.sourceRevision, "environment.sourceRevision"),
  };
  const baseline = normalizeRuntimeIdentity(evidence.baseline, "baseline");
  const candidate = normalizeRuntimeIdentity(evidence.candidate, "candidate");
  const stageEvidence = normalizeStageEvidence(evidence.stageEvidence);
  if (!Array.isArray(evidence.shadowRuns) || !evidence.shadowRuns.length) {
    throw new Error("runtime cutover evidence requires at least one shadow run.");
  }
  const shadowRuns = evidence.shadowRuns.map(normalizeShadowRun);
  const runIds = new Set(shadowRuns.map((run) => run.runId));
  if (runIds.size !== shadowRuns.length) throw new Error("runtime cutover shadow run IDs must be unique.");
  const observation = normalizeObservation(evidence.observation);
  const rollback = normalizeRollback(evidence.rollback);
  const escalation = normalizeEscalation(evidence.escalation);
  return {
    ...evidence,
    environment,
    baseline,
    candidate,
    stageEvidence,
    shadowRuns,
    observation,
    rollback,
    escalation,
    configurationFingerprint: cutoverConfigurationFingerprint({ environment, baseline, candidate, shadowRuns }),
  };
}

export function evaluateRuntimeCutover({ plan: planValue, policy: policyValue, evidence: evidenceValue, phase7Report, phase7ReportSha256, sourceArtifacts: sourceArtifactsValue }) {
  const plan = validateRuntimeCutoverPlan(planValue);
  const policy = validateRuntimeCutoverPolicy(policyValue);
  const evidence = normalizeRuntimeCutoverEvidence(evidenceValue);
  const phase7 = normalizePhase7Report(phase7Report, phase7ReportSha256);
  const sourceArtifacts = normalizeSourceArtifacts(sourceArtifactsValue, phase7ReportSha256);
  const generatedAt = new Date().toISOString();
  const gates = [];

  addPhase7Gate(gates, phase7);
  addEnvironmentGates(gates, policy, evidence);
  addExplicitStageGates(gates, evidence.stageEvidence);
  addIsolationGates(gates, plan, evidence);
  addShadowRunGates(gates, policy, evidence);
  addObservationGates(gates, policy, evidence.observation);
  addRollbackGates(gates, plan, evidence.rollback, evidence.escalation);
  addApprovalGates(gates, plan, policy);
  addChronologyGates(gates, { generatedAt, phase7, policy, evidence });

  const status = cutoverStatus(gates.map((item) => item.status));
  return {
    schemaVersion: RUNTIME_CUTOVER_REPORT_SCHEMA,
    generatedAt,
    campaignId: evidence.campaignId,
    evidenceKind: evidence.exampleOnly === true ? "example" : "operational",
    status,
    planId: plan.planId,
    policyId: policy.policyId,
    approval: {
      status: policy.approvalStatus,
      approvedBy: policy.approvedBy || null,
      approvedAt: policy.approvedAt || null,
      changeTicket: policy.changeTicket || null,
    },
    criteria: {
      minimumShadowRuns: policy.minimumShadowRuns,
      minimumObservationMinutes: policy.minimumObservationMinutes,
      thresholds: policy.thresholds,
      requireSchemaMatch: policy.requireSchemaMatch,
      requireValueChecksumMatch: policy.requireValueChecksumMatch,
      requireQuarantineChecksumMatch: policy.requireQuarantineChecksumMatch,
    },
    phase7Report: phase7,
    sourceArtifacts,
    target: {
      ...policy.target,
      sourceRevision: evidence.environment.sourceRevision,
    },
    evidenceEnvironment: evidence.environment,
    baseline: evidence.baseline,
    candidate: evidence.candidate,
    stageEvidence: evidence.stageEvidence,
    shadowSummary: summarizeShadowRuns(evidence.shadowRuns),
    observation: evidence.observation,
    rollback: evidence.rollback,
    escalation: evidence.escalation,
    configurationFingerprint: evidence.configurationFingerprint,
    gates,
  };
}

export function renderRuntimeCutoverMarkdown(report) {
  assertEqual(report?.schemaVersion, RUNTIME_CUTOVER_REPORT_SCHEMA, "runtime cutover report schemaVersion");
  const lines = [
    "# Kafka·Spark Phase 8 Runtime 전환 리포트",
    "",
    `- Campaign: ${report.campaignId}`,
    `- 생성 시각: ${report.generatedAt}`,
    `- 최종 판정: **${report.status}**`,
    `- Policy / 승인: ${report.policyId} / ${report.approval.status}`,
    `- 승인자 / 변경 티켓: ${report.approval.approvedBy || "-"} / ${report.approval.changeTicket || "-"}`,
    `- Target: ${report.target.sparkRuntime} + ${report.target.kafkaRuntime} / ${report.target.appEnvironment} / ${report.target.region}`,
    `- Source revision: ${report.target.sourceRevision}`,
    `- Phase 7 report SHA-256: ${report.phase7Report.sha256 || "-"}`,
    `- Plan / policy / evidence SHA-256: ${report.sourceArtifacts.plan.sha256} / ${report.sourceArtifacts.policy.sha256} / ${report.sourceArtifacts.evidence.sha256}`,
    "",
    "## Shadow 요약",
    "",
    "| 반복 | 최대 stored row delta | 최대 quarantine delta | schema 불일치 | value 불일치 | quarantine 불일치 |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${report.shadowSummary.runCount} | ${report.shadowSummary.maxStoredCountDelta} | ${report.shadowSummary.maxQuarantineCountDelta} | ${report.shadowSummary.schemaMismatchRuns} | ${report.shadowSummary.valueMismatchRuns} | ${report.shadowSummary.quarantineMismatchRuns} |`,
    "",
    "## 판정 근거",
    "",
    "| Gate | 상태 | 실제 | 기준 | 설명 |",
    "|---|---|---:|---:|---|",
  ];
  for (const item of report.gates) {
    lines.push(`| ${escapeTable(item.name)} | ${item.status} | ${display(item.actual)} | ${display(item.target)} | ${escapeTable(item.detail)} |`);
  }
  lines.push(
    "",
    "> `promotion-ready`만 운영 후보 Runtime 배포를 허용한다. `insufficient-evidence`는 승인 대기이고 `rollback-required`는 전환 중단 또는 롤백 대상이다.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function redactRuntimeCutoverEvidence(value) {
  if (Array.isArray(value)) return value.map(redactRuntimeCutoverEvidence);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    FORBIDDEN_KEYS.test(key) ? "[REDACTED]" : redactRuntimeCutoverEvidence(child),
  ]));
}

function normalizeTarget(value) {
  const sparkRuntime = runtimeId(value.sparkRuntime, SPARK_RUNTIMES, "target.sparkRuntime");
  const kafkaRuntime = runtimeId(value.kafkaRuntime, KAFKA_RUNTIMES, "target.kafkaRuntime");
  if (sparkRuntime === "spark-rest" && kafkaRuntime === "redpanda") {
    throw new Error("runtime cutover target must change at least one Runtime.");
  }
  return {
    appEnvironment: singleLine(value.appEnvironment, "target.appEnvironment"),
    storageEnvironment: singleLine(value.storageEnvironment, "target.storageEnvironment"),
    region: singleLine(value.region, "target.region"),
    sparkRuntime,
    kafkaRuntime,
  };
}

function normalizeRuntimeIdentity(value, name) {
  assertObject(value, `${name} runtime identity`);
  return {
    sparkRuntime: runtimeId(value.sparkRuntime, SPARK_RUNTIMES, `${name}.sparkRuntime`),
    kafkaRuntime: runtimeId(value.kafkaRuntime, KAFKA_RUNTIMES, `${name}.kafkaRuntime`),
    topic: singleLine(value.topic, `${name}.topic`),
    consumerGroup: singleLine(value.consumerGroup, `${name}.consumerGroup`),
    outputPrefix: objectStorageUri(value.outputPrefix, `${name}.outputPrefix`),
    checkpointPath: objectStorageUri(value.checkpointPath, `${name}.checkpointPath`),
  };
}

function normalizeStageEvidence(value) {
  assertObject(value, "stageEvidence");
  const result = {};
  for (const stage of EXPLICIT_STAGE_EVIDENCE) {
    const item = value[stage];
    if (item === null || item === undefined) {
      result[stage] = null;
      continue;
    }
    assertObject(item, `stageEvidence.${stage}`);
    if (!["passed", "failed", "not-run"].includes(item.status)) {
      throw new Error(`stageEvidence.${stage}.status must be passed, failed, or not-run.`);
    }
    result[stage] = {
      status: item.status,
      completedAt: item.completedAt ? new Date(isoTimestamp(item.completedAt, `stageEvidence.${stage}.completedAt`)).toISOString() : null,
      evidenceSha256: item.evidenceSha256 ? checksum(item.evidenceSha256, `stageEvidence.${stage}.evidenceSha256`) : null,
      artifactRef: item.artifactRef ? evidenceArtifactUri(item.artifactRef, `stageEvidence.${stage}.artifactRef`) : null,
    };
  }
  return result;
}

function normalizeShadowRun(value, index) {
  assertObject(value, `shadowRuns[${index}]`);
  return {
    runId: identifier(value.runId, `shadowRuns[${index}].runId`),
    inputFingerprint: checksum(value.inputFingerprint, `shadowRuns[${index}].inputFingerprint`),
    producedCount: nonNegativeInteger(value.producedCount, `shadowRuns[${index}].producedCount`),
    baseline: normalizeRunResult(value.baseline, `shadowRuns[${index}].baseline`),
    candidate: normalizeRunResult(value.candidate, `shadowRuns[${index}].candidate`),
  };
}

function normalizeRunResult(value, name) {
  assertObject(value, name);
  const result = {};
  for (const field of ["consumedCount", "storedCount", "quarantinedCount", "replayedCount", "missingCount", "unexplainedDuplicateCount"]) {
    result[field] = nonNegativeInteger(value[field], `${name}.${field}`);
  }
  result.schemaFingerprint = checksum(value.schemaFingerprint, `${name}.schemaFingerprint`);
  result.valueChecksum = checksum(value.valueChecksum, `${name}.valueChecksum`);
  result.quarantineChecksum = checksum(value.quarantineChecksum, `${name}.quarantineChecksum`);
  return result;
}

function normalizeObservation(value) {
  assertObject(value, "observation");
  const startedAt = isoTimestamp(value.startedAt, "observation.startedAt");
  const completedAt = isoTimestamp(value.completedAt, "observation.completedAt");
  if (completedAt < startedAt) throw new Error("observation.completedAt must not be earlier than startedAt.");
  const totalRuns = nonNegativeInteger(value.totalRuns, "observation.totalRuns");
  const failedRuns = nonNegativeInteger(value.failedRuns, "observation.failedRuns");
  if (failedRuns > totalRuns) throw new Error("observation.failedRuns must not exceed totalRuns.");
  return {
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMinutes: round((completedAt - startedAt) / 60000, 3),
    totalRuns,
    failedRuns,
    errorRate: totalRuns ? round(failedRuns / totalRuns, 6) : null,
    maxLag: nonNegativeNumber(value.maxLag, "observation.maxLag"),
    p95LatencyMs: nonNegativeNumber(value.p95LatencyMs, "observation.p95LatencyMs"),
    costUsd: nonNegativeNumber(value.costUsd, "observation.costUsd"),
  };
}

function normalizeRollback(value) {
  assertObject(value, "rollback");
  return {
    sparkRuntime: runtimeId(value.sparkRuntime, SPARK_RUNTIMES, "rollback.sparkRuntime"),
    kafkaRuntime: runtimeId(value.kafkaRuntime, KAFKA_RUNTIMES, "rollback.kafkaRuntime"),
    previousGoodRevision: revision(value.previousGoodRevision, "rollback.previousGoodRevision"),
    owner: singleLine(value.owner, "rollback.owner"),
    runbookRef: safeRepositoryPath(value.runbookRef, "rollback.runbookRef"),
    lastTestedAt: value.lastTestedAt ? new Date(isoTimestamp(value.lastTestedAt, "rollback.lastTestedAt")).toISOString() : null,
  };
}

function normalizeEscalation(value) {
  assertObject(value, "escalation");
  return {
    owner: singleLine(value.owner, "escalation.owner"),
    channel: singleLine(value.channel, "escalation.channel"),
  };
}

function normalizePhase7Report(value, shaValue) {
  if (!value || typeof value !== "object") {
    return { schemaVersion: null, status: null, profileId: null, approvalStatus: null, approvedBy: null, approvedAt: null, evidenceKind: null, contractComplete: false, sha256: null };
  }
  const sha256 = SHA256_PATTERN.test(String(shaValue || "").toLowerCase()) ? String(shaValue).toLowerCase() : null;
  const approvedAt = safeIsoTimestamp(value.profile?.approvedAt);
  return {
    schemaVersion: value.schemaVersion || null,
    status: value.status || null,
    profileId: value.profile?.profileId || null,
    approvalStatus: value.profile?.approvalStatus || null,
    approvedBy: value.profile?.approvedBy || null,
    approvedAt,
    evidenceKind: value.evidenceKind || null,
    contractComplete: phase7ContractComplete(value),
    sha256,
  };
}

function normalizeSourceArtifacts(value, phase7ReportSha256) {
  assertObject(value, "runtime cutover sourceArtifacts");
  const normalized = {};
  for (const name of ["plan", "policy", "evidence", "phase7"]) {
    assertObject(value[name], `sourceArtifacts.${name}`);
    normalized[name] = { sha256: checksum(value[name].sha256, `sourceArtifacts.${name}.sha256`) };
  }
  if (normalized.phase7.sha256 !== String(phase7ReportSha256 || "").toLowerCase()) {
    throw new Error("sourceArtifacts.phase7.sha256 must match the Phase 7 report SHA-256.");
  }
  return normalized;
}

function phase7ContractComplete(value) {
  const minimumRuns = value?.profile?.minimumSuccessfulRuns;
  const coverage = value?.scenarioCoverage;
  const scenarios = value?.scenarios;
  if (!Number.isSafeInteger(minimumRuns) || minimumRuns <= 0 || !coverage || !Array.isArray(scenarios)) return false;
  if (!exactStringSet(coverage.requiredScenarioIds, PHASE7_SCENARIOS) || !Array.isArray(coverage.missingScenarioIds) || coverage.missingScenarioIds.length) return false;
  if (scenarios.length !== PHASE7_SCENARIOS.size) return false;
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return false;
    scenarioIds.add(scenario.scenarioId);
    if (scenario.status !== "passed" || !Number.isSafeInteger(scenario.runCount) || scenario.runCount < minimumRuns) return false;
    if (!allPassedGates(scenario.gates) || !Array.isArray(scenario.runs) || scenario.runs.length !== scenario.runCount) return false;
    for (const run of scenario.runs) {
      if (!run || run.status !== "passed" || !allPassedGates(run.gates)) return false;
    }
  }
  return scenarioIds.size === PHASE7_SCENARIOS.size && [...scenarioIds].every((scenarioId) => PHASE7_SCENARIOS.has(scenarioId));
}

function allPassedGates(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item && item.status === "passed" && typeof item.name === "string" && item.name);
}

function exactStringSet(value, expected) {
  return Array.isArray(value) && value.length === expected.size && new Set(value).size === expected.size && value.every((item) => expected.has(item));
}

function addPhase7Gate(gates, phase7) {
  const complete = phase7.schemaVersion === STREAMING_REPORT_SCHEMA
    && phase7.status === "passed"
    && phase7.approvalStatus === "approved"
    && phase7.approvedBy
    && phase7.approvedAt
    && phase7.evidenceKind === "operational"
    && phase7.contractComplete === true
    && phase7.sha256;
  gates.push(gate(
    "phase7-approved-report",
    complete ? "passed" : "insufficient-evidence",
    complete ? phase7.status : null,
    "all 16 scenarios passed + approved + SHA-256",
    "Phase 8 promotion requires the exact approved operational Phase 7 performance report.",
  ));
}

function addEnvironmentGates(gates, policy, evidence) {
  gates.push(gate(
    "operational-evidence",
    evidence.exampleOnly === true ? "insufficient-evidence" : "passed",
    evidence.exampleOnly === true ? "example" : "operational",
    "operational",
    "Checked-in example evidence cannot authorize Runtime promotion.",
  ));
  gates.push(equalityGate("evidence-environment", evidence.environment.name, policy.evidenceEnvironment, "Shadow evidence must come from the policy environment."));
  gates.push(equalityGate("target-region", evidence.environment.region, policy.target.region, "Shadow evidence and promotion target must use the same region."));
  gates.push(equalityGate("candidate-spark-runtime", evidence.candidate.sparkRuntime, policy.target.sparkRuntime, "Candidate Spark Runtime must match the promotion target."));
  gates.push(equalityGate("candidate-kafka-runtime", evidence.candidate.kafkaRuntime, policy.target.kafkaRuntime, "Candidate Kafka Runtime must match the promotion target."));
  gates.push(equalityGate("baseline-spark-runtime", evidence.baseline.sparkRuntime, "spark-rest", "The shadow baseline must remain the Docker Spark REST rollback Runtime."));
  gates.push(equalityGate("baseline-kafka-runtime", evidence.baseline.kafkaRuntime, "redpanda", "The shadow baseline must remain the Redpanda rollback Runtime."));
  gates.push(gate(
    "candidate-differs-from-baseline",
    evidence.baseline.sparkRuntime !== evidence.candidate.sparkRuntime || evidence.baseline.kafkaRuntime !== evidence.candidate.kafkaRuntime ? "passed" : "failed",
    `${evidence.baseline.sparkRuntime}+${evidence.baseline.kafkaRuntime} -> ${evidence.candidate.sparkRuntime}+${evidence.candidate.kafkaRuntime}`,
    "different Runtime",
    "A cutover campaign must compare a changed Runtime.",
  ));
}

function addExplicitStageGates(gates, stageEvidence) {
  for (const stage of EXPLICIT_STAGE_EVIDENCE) {
    const item = stageEvidence[stage];
    let status = "insufficient-evidence";
    if (item?.status === "failed") status = "failed";
    if (item?.status === "passed" && item.completedAt && item.evidenceSha256 && item.artifactRef) status = "passed";
    gates.push(gate(
      `stage:${stage}`,
      status,
      item?.status || null,
      "passed + timestamp + artifactRef + SHA-256",
      `Phase 8 stage ${stage} must have durable evidence.`,
    ));
  }
}

function addIsolationGates(gates, plan, evidence) {
  const baseline = evidence.baseline;
  const candidate = evidence.candidate;
  gates.push(gate(
    "shadow-topic",
    baseline.topic === candidate.topic ? "passed" : "failed",
    candidate.topic,
    baseline.topic,
    "Both consumers must read the same logical topic fixture.",
  ));
  gates.push(gate(
    "consumer-group-isolation",
    plan.safety.requireDistinctConsumerGroups && baseline.consumerGroup !== candidate.consumerGroup ? "passed" : "failed",
    candidate.consumerGroup,
    `not ${baseline.consumerGroup}`,
    "Baseline and candidate must never share a consumer group.",
  ));
  gates.push(uriIsolationGate("output-prefix-isolation", baseline.outputPrefix, candidate.outputPrefix));
  gates.push(uriIsolationGate("checkpoint-isolation", baseline.checkpointPath, candidate.checkpointPath));
}

function addShadowRunGates(gates, policy, evidence) {
  const minimumRuns = policy.minimumShadowRuns;
  gates.push(gate(
    "shadow-repeat-count",
    minimumRuns === null ? "insufficient-evidence" : evidence.shadowRuns.length >= minimumRuns ? "passed" : "insufficient-evidence",
    evidence.shadowRuns.length,
    minimumRuns,
    "The same isolated configuration must be repeated before promotion.",
  ));
  const inputFingerprints = new Set(evidence.shadowRuns.map((run) => run.inputFingerprint));
  gates.push(gate(
    "comparable-input",
    inputFingerprints.size === 1 ? "passed" : "failed",
    inputFingerprints.size,
    1,
    "Every shadow repeat must use the same input fingerprint.",
  ));

  const summary = summarizeShadowRuns(evidence.shadowRuns);
  for (const run of evidence.shadowRuns) addRunIntegrityGates(gates, run);
  addThresholdGate(gates, "stored-count-delta", summary.maxStoredCountDelta, policy.thresholds.maxStoredCountDelta, "Baseline/candidate stored output counts must stay within the approved delta.");
  addThresholdGate(gates, "quarantine-count-delta", summary.maxQuarantineCountDelta, policy.thresholds.maxQuarantineCountDelta, "Baseline/candidate quarantine counts must stay within the approved delta.");
  gates.push(requirementGate("schema-match", summary.schemaMismatchRuns === 0, policy.requireSchemaMatch, summary.schemaMismatchRuns, "Schema fingerprints must match when required."));
  gates.push(requirementGate("value-checksum-match", summary.valueMismatchRuns === 0, policy.requireValueChecksumMatch, summary.valueMismatchRuns, "Canonical value checksums must match when required."));
  gates.push(requirementGate("quarantine-checksum-match", summary.quarantineMismatchRuns === 0, policy.requireQuarantineChecksumMatch, summary.quarantineMismatchRuns, "Quarantine checksums must match when required."));
}

function addRunIntegrityGates(gates, run) {
  for (const side of ["baseline", "candidate"]) {
    const result = run[side];
    const reconciled = result.storedCount + result.quarantinedCount - result.replayedCount;
    const passed = runIntegrityPassed(run, side);
    gates.push(gate(
      `run:${run.runId}:${side}-integrity`,
      passed ? "passed" : "failed",
      `${result.consumedCount}/${reconciled}/${result.missingCount}/${result.unexplainedDuplicateCount}`,
      `${run.producedCount}/${run.producedCount}/0/0`,
      "produced=consumed=sink reconciliation, missing=0, unexplained duplicate=0.",
    ));
  }
}

function addObservationGates(gates, policy, observation) {
  const minimumMinutes = policy.minimumObservationMinutes;
  gates.push(gate(
    "observation-duration",
    minimumMinutes === null ? "insufficient-evidence" : observation.durationMinutes >= minimumMinutes ? "passed" : "insufficient-evidence",
    observation.durationMinutes,
    minimumMinutes,
    "Candidate observation must cover the approved minimum duration.",
  ));
  addThresholdGate(gates, "observation-error-rate", observation.errorRate, policy.thresholds.maxErrorRate, "Observed failure rate must stay within the approved limit.");
  addThresholdGate(gates, "observation-max-lag", observation.maxLag, policy.thresholds.maxLag, "Observed lag must stay within the approved limit.");
  addThresholdGate(gates, "observation-p95-latency", observation.p95LatencyMs, policy.thresholds.maxP95LatencyMs, "Observed P95 latency must stay within the approved limit.");
  addThresholdGate(gates, "observation-cost", observation.costUsd, policy.thresholds.maxCostUsd, "Observed cost must stay within the approved limit.");
}

function addRollbackGates(gates, plan, rollback, escalation) {
  const runtimeReady = rollback.sparkRuntime === plan.defaultRuntime.sparkRuntime
    && rollback.kafkaRuntime === plan.defaultRuntime.kafkaRuntime;
  gates.push(gate(
    "rollback-target",
    runtimeReady ? "passed" : "failed",
    `${rollback.sparkRuntime}+${rollback.kafkaRuntime}`,
    `${plan.defaultRuntime.sparkRuntime}+${plan.defaultRuntime.kafkaRuntime}`,
    "Rollback must restore the checked-in default Runtime pair.",
  ));
  gates.push(gate(
    "rollback-tested",
    rollback.lastTestedAt ? "passed" : "insufficient-evidence",
    rollback.lastTestedAt,
    "timestamp",
    "Rollback commands must be tested without resetting data.",
  ));
  gates.push(gate(
    "escalation-owner",
    rollback.owner && escalation.owner && escalation.channel ? "passed" : "insufficient-evidence",
    escalation.channel || null,
    "owner + channel",
    "An accountable rollback owner and escalation channel are required.",
  ));
}

function addApprovalGates(gates, plan, policy) {
  const approved = policy.approvalStatus === "approved" && policy.approvedBy && policy.approvedAt && policy.changeTicket;
  gates.push(gate(
    "promotion-approval",
    plan.safety.requireExplicitPromotionApproval && approved ? "passed" : "insufficient-evidence",
    policy.approvalStatus,
    "approved",
    "Promotion is always a separate explicit operator decision.",
  ));
  gates.push(gate(
    "automatic-promotion-disabled",
    plan.safety.allowAutomaticPromotion === false ? "passed" : "failed",
    plan.safety.allowAutomaticPromotion,
    false,
    "The report may authorize a deployment but must never change Runtime by itself.",
  ));
}

function addChronologyGates(gates, { generatedAt, phase7, policy, evidence }) {
  const stageTimes = EXPLICIT_STAGE_EVIDENCE.map((stage) => timestampOrNull(evidence.stageEvidence[stage]?.completedAt));
  const phase7ApprovedAt = timestampOrNull(phase7.approvedAt);
  const observationStartedAt = timestampOrNull(evidence.observation.startedAt);
  const observationCompletedAt = timestampOrNull(evidence.observation.completedAt);
  const approvedAt = timestampOrNull(policy.approvedAt);
  const rollbackTestedAt = timestampOrNull(evidence.rollback.lastTestedAt);
  const generatedAtTime = timestampOrNull(generatedAt);

  addTimeGate(gates, "chronology:phase7-before-phase8", [phase7ApprovedAt, stageTimes[0]], ([phase7Time, dockerTime]) => phase7Time <= dockerTime, "Phase 7 approval must precede Phase 8 execution.");
  addTimeGate(gates, "chronology:stage-order", stageTimes, (values) => values.every((value, index) => index === 0 || values[index - 1] <= value), "Phase 8 explicit stages must complete in plan order.");
  addTimeGate(gates, "chronology:observation-after-small-workload", [stageTimes.at(-1), observationStartedAt], ([smallWorkloadTime, observationTime]) => smallWorkloadTime <= observationTime, "Observation must start after the small-workload cutover evidence completes.");
  addTimeGate(gates, "chronology:approval-after-observation", [observationCompletedAt, approvedAt], ([observationTime, approvalTime]) => observationTime <= approvalTime, "Promotion approval must occur after observation completes.");
  addTimeGate(gates, "chronology:rollback-test-before-approval", [rollbackTestedAt, approvedAt], ([rollbackTime, approvalTime]) => rollbackTime <= approvalTime, "Rollback readiness must be tested before promotion approval.");
  const evidenceTimes = [phase7ApprovedAt, ...stageTimes, observationStartedAt, observationCompletedAt, rollbackTestedAt, approvedAt];
  addTimeGate(gates, "chronology:no-future-evidence", [...evidenceTimes, generatedAtTime], (values) => values.slice(0, -1).every((value) => value <= values.at(-1)), "Evidence and approvals must not be later than report generation.");
}

function addTimeGate(gates, name, values, predicate, detail) {
  if (values.some((value) => !Number.isFinite(value))) {
    gates.push(gate(name, "insufficient-evidence", null, "ordered timestamps", `${detail} One or more timestamps are missing.`));
    return;
  }
  gates.push(gate(name, predicate(values) ? "passed" : "failed", values.map((value) => new Date(value).toISOString()).join(" <= "), "ordered timestamps", detail));
}

function summarizeShadowRuns(runs) {
  return {
    runCount: runs.length,
    integrityFailureSides: runs.flatMap((run) => ["baseline", "candidate"].map((side) => runIntegrityPassed(run, side))).filter((passed) => !passed).length,
    maxStoredCountDelta: maximum(runs.map((run) => Math.abs(run.baseline.storedCount - run.candidate.storedCount))),
    maxQuarantineCountDelta: maximum(runs.map((run) => Math.abs(run.baseline.quarantinedCount - run.candidate.quarantinedCount))),
    schemaMismatchRuns: runs.filter((run) => run.baseline.schemaFingerprint !== run.candidate.schemaFingerprint).length,
    valueMismatchRuns: runs.filter((run) => run.baseline.valueChecksum !== run.candidate.valueChecksum).length,
    quarantineMismatchRuns: runs.filter((run) => run.baseline.quarantineChecksum !== run.candidate.quarantineChecksum).length,
  };
}

function runIntegrityPassed(run, side) {
  const result = run[side];
  const reconciled = result.storedCount + result.quarantinedCount - result.replayedCount;
  return result.consumedCount === run.producedCount
    && reconciled === result.consumedCount
    && result.missingCount === 0
    && result.unexplainedDuplicateCount === 0;
}

function cutoverConfigurationFingerprint({ environment, baseline, candidate, shadowRuns }) {
  return sha256Hex(stableJson({
    environment,
    baseline,
    candidate,
    inputFingerprint: shadowRuns[0]?.inputFingerprint || null,
  }));
}

function addThresholdGate(gates, name, actual, target, detail) {
  if (target === null || target === undefined) {
    gates.push(gate(name, "insufficient-evidence", actual, target, "The promotion threshold is not approved."));
    return;
  }
  if (!Number.isFinite(actual)) {
    gates.push(gate(name, "insufficient-evidence", actual, target, `${detail} The measured value is missing.`));
    return;
  }
  gates.push(gate(name, actual <= target ? "passed" : "failed", actual, target, detail));
}

function requirementGate(name, matches, required, actual, detail) {
  return gate(name, !required || matches ? "passed" : "failed", actual, required ? 0 : "not-required", detail);
}

function equalityGate(name, actual, target, detail) {
  return gate(name, actual === target ? "passed" : "failed", actual, target, detail);
}

function uriIsolationGate(name, baseline, candidate) {
  const isolated = !uriOverlaps(baseline, candidate);
  return gate(name, isolated ? "passed" : "failed", candidate, `disjoint from ${baseline}`, "Paths must be different and neither path may contain the other.");
}

function uriOverlaps(left, right) {
  const normalizedLeft = left.replace(/\/$/, "");
  const normalizedRight = right.replace(/\/$/, "");
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function cutoverStatus(statuses) {
  if (statuses.includes("failed")) return "rollback-required";
  if (statuses.includes("insufficient-evidence")) return "insufficient-evidence";
  return "promotion-ready";
}

function gate(name, status, actual, target, detail) {
  return { name, status, actual, target, detail };
}

function runtimeId(value, allowed, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) throw new Error(`${name} is not a supported Runtime.`);
  return normalized;
}

function objectStorageUri(value, name) {
  const normalized = String(value || "").trim().replace(/\/$/, "");
  if (!/^s3a?:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(normalized)) {
    throw new Error(`${name} must be an S3/S3A prefix without query or fragment.`);
  }
  if (/\/(?:\.\.?)(?:\/|$)/.test(normalized)
    || /%(?:2e|2f|5c)/i.test(normalized)
    || normalized.includes("//", normalized.indexOf("//") + 2)) {
    throw new Error(`${name} contains an unsafe path segment.`);
  }
  return normalized.replace(/^s3:\/\//, "s3a://");
}

function evidenceArtifactUri(value, name) {
  return objectStorageUri(value, name);
}

function safeRepositoryPath(value, name) {
  const normalized = String(value || "").trim();
  if (!/^(?:docs|scripts)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?$/.test(normalized) || normalized.includes("..")) {
    throw new Error(`${name} must reference a checked-in docs/ or scripts/ path.`);
  }
  return normalized;
}

function assertNoSensitiveEvidence(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveEvidence(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string") {
    if (redactSensitiveText(value) !== value) throw new Error(`Sensitive value is not allowed in runtime cutover evidence: ${path}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`Sensitive key is not allowed in runtime cutover evidence: ${path}.${key}`);
    assertNoSensitiveEvidence(child, `${path}.${key}`);
  }
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s|]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*[^\s|]+/gi, "[REDACTED]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:[0-9]{2,5}\b/g, "[ENDPOINT]");
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

function assertDeepEqual(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} does not match the required contract.`);
}

function assertIdentifier(value, name) {
  identifier(value, name);
}

function identifier(value, name) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error(`${name} must be a safe identifier.`);
  return normalized;
}

function assertText(value, name) {
  singleLine(value, name);
}

function singleLine(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error(`${name} must be a non-empty single line.`);
  return normalized;
}

function checksum(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a SHA-256 hex digest.`);
  return normalized;
}

function revision(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!REVISION_PATTERN.test(normalized)) throw new Error(`${name} must be a git revision.`);
  return normalized;
}

function isoTimestamp(value, name) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    throw new Error(`${name} must be an ISO timestamp with a timezone.`);
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
}

function safeIsoTimestamp(value) {
  try {
    return value ? new Date(isoTimestamp(value, "timestamp")).toISOString() : null;
  } catch {
    return null;
  }
}

function timestampOrNull(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function nullablePositiveInteger(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer or null.`);
  return value;
}

function nullablePositiveNumber(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number or null.`);
  return Number(value);
}

function nullableNonNegativeNumber(value, name) {
  if (value === null || value === undefined) return null;
  return nonNegativeNumber(value, name);
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return Number(value);
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
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
