import { createHash } from "node:crypto";

import { evaluateAwsStagingSmokeEvidence } from "./awsStagingSmoke.mjs";
import { evaluateAwsStagingTtlSweepEvidence } from "./awsStagingLifecycle.mjs";

export const AWS_STAGING_HANDOFF_SCHEMA = "asklake.aws-staging-handoff.v1";

const STACK_ID = /^[a-z0-9][a-z0-9-]{2,15}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const FORBIDDEN = /(access.?key|secret|credential|password|authorization|bootstrap.?broker|session.?token)/i;

export function createAwsStagingHandoff({ cleanupReceipt, smokeEvidence, ttlSweepEvidence }, contract) {
  rejectSensitive({ cleanupReceipt, smokeEvidence, ttlSweepEvidence });
  const smoke = evaluateAwsStagingSmokeEvidence(smokeEvidence, contract);
  const ttl = evaluateAwsStagingTtlSweepEvidence(ttlSweepEvidence, contract);
  const cleanup = normalizeCleanup(cleanupReceipt, smoke.evidence);
  if (ttl.attentionRequired) fail("TTL sweep requires operator action before handoff.");
  const jobRuns = smoke.evidence.resources.emrJobRuns.map((job) => Object.freeze({
    applicationId: job.applicationId,
    jobRunId: job.jobRunId,
    workload: job.workload,
  }));
  return Object.freeze({
    cleanup: Object.freeze(cleanup),
    contractId: contract.contractId,
    environment: contract.environment,
    evidence: Object.freeze({
      batchReportUri: smoke.evidence.batch.reportUri,
      continuousReportUri: smoke.evidence.continuous.reportUri,
      jobRuns: Object.freeze(jobRuns),
      priceSnapshotUri: smoke.evidence.resources.priceSnapshotUri,
      smokeEvidenceSha256: sha256(smoke.evidence),
    }),
    phase7Pilot: Object.freeze({
      eligible: false,
      blockers: Object.freeze([
        "Phase 4 smoke is a functional connectivity check, not repeated performance evidence.",
        "Approved Phase 7 SLO profile and repeated AWS scenario evidence are required.",
        "CloudWatch worker metrics and actual cost evidence must be collected per Phase 7 run.",
      ]),
    }),
    region: contract.region,
    schemaVersion: AWS_STAGING_HANDOFF_SCHEMA,
    sourceRevision: smoke.evidence.sourceRevision,
    stackId: smoke.evidence.stackId,
    status: "handoff-ready",
    ttlSweep: Object.freeze(ttl.summary),
  });
}

export function renderAwsStagingHandoffMarkdown(handoff) {
  const value = normalizeHandoff(handoff);
  const rows = value.evidence.jobRuns
    .map((job) => `| ${job.workload} | ${job.applicationId} | ${job.jobRunId} |`)
    .join("\n");
  return [
    "# AWS Staging 운영 인계",
    "",
    `- 상태: \`${value.status}\``,
    `- Stack: \`${value.stackId}\``,
    `- Source revision: \`${value.sourceRevision}\``,
    `- Region: \`${value.region}\``,
    "",
    "## 보존된 evidence",
    "",
    `- Batch report: \`${value.evidence.batchReportUri}\``,
    `- Continuous report: \`${value.evidence.continuousReportUri}\``,
    `- 실행 시점 가격 snapshot: \`${value.evidence.priceSnapshotUri}\``,
    `- Smoke evidence SHA-256: \`${value.evidence.smokeEvidenceSha256}\``,
    "",
    "| workload | EMR application | Job Run |",
    "| --- | --- | --- |",
    rows,
    "",
    "## 정리·TTL 상태",
    "",
    `- smoke cleanup: \`${value.cleanup.status}\` (plan SHA-256: \`${value.cleanup.planFingerprint}\`)`,
    `- TTL sweep: active ${value.ttlSweep.activeCount}, empty ${value.ttlSweep.emptyCount}, expired ${value.ttlSweep.expiredCount}, invalid ${value.ttlSweep.invalidCount}`,
    "",
    "## Phase 7 pilot",
    "",
    "이 handoff는 Phase 7 pilot 승인이 아니다.",
    "",
    ...value.phase7Pilot.blockers.map((blocker) => `- ${blocker}`),
    "",
  ].join("\n");
}

function normalizeCleanup(value, smokeEvidence) {
  if (!isObject(value)
    || value.schemaVersion !== "asklake.aws-staging-smoke-cleanup.v1"
    || value.status !== "destroy-request-completed") fail("Cleanup receipt is invalid.");
  const stackId = required(value.stackId, "cleanup stackId");
  if (!STACK_ID.test(stackId) || stackId !== smokeEvidence.stackId) fail("Cleanup stack does not match smoke evidence.");
  const commit = required(value.commit, "cleanup commit");
  if (!SHA.test(commit) || commit !== smokeEvidence.sourceRevision) fail("Cleanup commit does not match smoke evidence.");
  const planFingerprint = required(value.planFingerprint, "cleanup plan fingerprint");
  if (!/^[a-f0-9]{64}$/.test(planFingerprint)) fail("Cleanup plan fingerprint is invalid.");
  if (!["Success", "Failed", "Cancelled", "TimedOut", "Undeliverable", "Terminated"].includes(value.smokeCommandStatus)) {
    fail("Cleanup command status is invalid.");
  }
  return {
    planFingerprint,
    smokeCommandStatus: value.smokeCommandStatus,
    status: value.status,
  };
}

function normalizeHandoff(value) {
  if (!isObject(value) || value.schemaVersion !== AWS_STAGING_HANDOFF_SCHEMA || value.status !== "handoff-ready") {
    fail("Handoff is invalid.");
  }
  rejectSensitive(value);
  return value;
}

function rejectSensitive(value, path = "handoff") {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitive(item, `${path}[${index}]`));
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN.test(key)) fail(`Sensitive handoff field is not allowed: ${path}.${key}.`);
      rejectSensitive(item, `${path}.${key}`);
    }
  }
  if (typeof value === "string" && (/AKIA[0-9A-Z]{16}/.test(value) || /boot[^\s,]*\.kafka[^\s,]*:9098/i.test(value))) {
    fail(`Sensitive handoff value is not allowed: ${path}.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\0]/.test(text)) fail(`${name} is invalid.`);
  return text;
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_HANDOFF_INVALID";
  throw error;
}
