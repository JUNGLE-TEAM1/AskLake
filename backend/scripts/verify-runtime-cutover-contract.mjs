import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_CUTOVER_REPORT_SCHEMA,
  evaluateRuntimeCutover,
  redactRuntimeCutoverEvidence,
  renderRuntimeCutoverMarkdown,
  sha256Hex,
  validateRuntimeCutoverPlan,
  validateRuntimeCutoverPolicy,
  normalizeRuntimeCutoverEvidence,
} from "../src/runtimeCutover.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(backendDir, "..");
const fixtureDir = path.join(backendDir, "fixtures", "runtime-cutover");
const defaultPlanPath = path.join(fixtureDir, "phase8-rollout-plan.json");
const defaultPolicyPath = path.join(fixtureDir, "phase8-cutover-policy.draft.json");
const defaultEvidencePath = path.join(fixtureDir, "phase8-cutover-evidence.example.json");
const gateScript = path.join(backendDir, "scripts", "verify-runtime-cutover-gate.py");

const args = parseArgs(process.argv.slice(2));
if (args.configOnly || process.argv.length === 2) verifyContract();
else generateReport(args);

function verifyContract() {
  const plan = readJson(defaultPlanPath);
  const draftPolicy = readJson(defaultPolicyPath);
  const evidence = readJson(defaultEvidencePath);
  validateRuntimeCutoverPlan(plan);
  validateRuntimeCutoverPolicy(draftPolicy);
  const normalized = normalizeRuntimeCutoverEvidence(evidence);
  assert.notEqual(normalized.baseline.consumerGroup, normalized.candidate.consumerGroup);
  assert.notEqual(normalized.baseline.outputPrefix, normalized.candidate.outputPrefix);
  assert.notEqual(normalized.baseline.checkpointPath, normalized.candidate.checkpointPath);

  const revision = gitRevision();
  const approvedPolicy = approvedExamplePolicy(draftPolicy);
  const testEvidence = structuredClone(evidence);
  testEvidence.exampleOnly = false;
  testEvidence.environment.sourceRevision = revision;
  testEvidence.rollback.previousGoodRevision = revision;
  const phase7 = approvedPhase7Report();
  const phase7Raw = `${JSON.stringify(phase7, null, 2)}\n`;
  const passed = evaluateRuntimeCutover({
    plan,
    policy: approvedPolicy,
    evidence: testEvidence,
    phase7Report: phase7,
    phase7ReportSha256: sha256Hex(phase7Raw),
  });
  assert.equal(passed.schemaVersion, RUNTIME_CUTOVER_REPORT_SCHEMA);
  assert.equal(passed.status, "promotion-ready");
  assert(passed.gates.every((gate) => gate.status === "passed"));

  const draft = evaluateRuntimeCutover({
    plan,
    policy: draftPolicy,
    evidence: testEvidence,
    phase7Report: phase7,
    phase7ReportSha256: sha256Hex(phase7Raw),
  });
  assert.equal(draft.status, "insufficient-evidence");

  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.candidate.consumerGroup = copy.baseline.consumerGroup;
  }, "consumer-group-isolation", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.candidate.outputPrefix = `${copy.baseline.outputPrefix}/candidate`;
  }, "output-prefix-isolation", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.candidate.checkpointPath = copy.baseline.checkpointPath;
  }, "checkpoint-isolation", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.shadowRuns[0].candidate.valueChecksum = "abababababababababababababababababababababababababababababababab";
  }, "value-checksum-match", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.observation.maxLag = 11;
  }, "observation-max-lag", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.stageEvidence["aws-continuous-staging"].status = "not-run";
  }, "stage:aws-continuous-staging", "insufficient-evidence");
  const unapprovedPhase7 = structuredClone(phase7);
  unapprovedPhase7.profile.approvalStatus = "draft";
  const phase7Incomplete = evaluateRuntimeCutover({
    plan,
    policy: approvedPolicy,
    evidence: testEvidence,
    phase7Report: unapprovedPhase7,
    phase7ReportSha256: sha256Hex(`${JSON.stringify(unapprovedPhase7, null, 2)}\n`),
  });
  assert.equal(phase7Incomplete.status, "insufficient-evidence");
  assert.throws(
    () => normalizeRuntimeCutoverEvidence({ ...testEvidence, authorization: "Bearer should-not-exist" }),
    /Sensitive key is not allowed/,
  );
  assert.throws(
    () => normalizeRuntimeCutoverEvidence({ ...testEvidence, note: "aws_secret_access_key=should-not-exist" }),
    /Sensitive value is not allowed/,
  );
  assert.deepEqual(
    redactRuntimeCutoverEvidence({ nested: { password: "secret", safe: "value" } }),
    { nested: { password: "[REDACTED]", safe: "value" } },
  );
  const markdown = renderRuntimeCutoverMarkdown(passed);
  assert(markdown.includes("Phase 8 Runtime 전환 리포트"));
  assert(markdown.includes("최종 판정: **promotion-ready**"));

  verifyPythonGate(passed, phase7Raw, revision);
  console.log("Runtime cutover promotion and rollback contract verified.");
}

function generateReport(options) {
  const plan = readJson(path.resolve(options.planPath || defaultPlanPath));
  const policy = readJson(path.resolve(options.policyPath || defaultPolicyPath));
  const evidence = readJson(path.resolve(options.evidencePath || defaultEvidencePath));
  if (!options.phase7ReportPath) throw new Error("Pass --phase7-report <path>.");
  const phase7Path = path.resolve(options.phase7ReportPath);
  const phase7Raw = readFileSync(phase7Path, "utf8");
  const phase7Report = JSON.parse(phase7Raw);
  validateRuntimeCutoverPlan(plan);
  const report = evaluateRuntimeCutover({
    plan,
    policy,
    evidence,
    phase7Report,
    phase7ReportSha256: sha256Hex(phase7Raw),
  });
  const outputDir = path.resolve(options.outputDir || path.join(backendDir, "tmp", "runtime-cutover"));
  const runId = safeRunId(options.runId || `phase8-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${runId}.json`);
  const markdownPath = path.join(outputDir, `${runId}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(redactRuntimeCutoverEvidence(report), null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderRuntimeCutoverMarkdown(report), "utf8");
  console.log(`ASKLAKE_RUNTIME_CUTOVER_STATUS=${report.status}`);
  console.log(`ASKLAKE_RUNTIME_CUTOVER_JSON=${jsonPath}`);
  console.log(`ASKLAKE_RUNTIME_CUTOVER_MARKDOWN=${markdownPath}`);
  if (report.status === "rollback-required") process.exitCode = 1;
  if (report.status === "insufficient-evidence") process.exitCode = 2;
}

function verifyPythonGate(report, phase7Raw, revision) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "asklake-runtime-cutover-"));
  const reportPath = path.join(tempDir, "cutover.json");
  const phase7Path = path.join(tempDir, "phase7.json");
  const envPath = path.join(tempDir, "deploy.env");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(phase7Path, phase7Raw, "utf8");
  writeFileSync(envPath, deploymentEnv("emr-serverless", "msk"), "utf8");
  const baseArgs = [gateScript, "--report", reportPath, "--phase7-report", phase7Path, "--env-file", envPath, "--repository-root", repositoryRoot];
  execFileSync("python3", baseArgs, { stdio: "pipe" });

  const wrongRevision = structuredClone(report);
  wrongRevision.target.sourceRevision = revision === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40);
  writeFileSync(reportPath, `${JSON.stringify(wrongRevision, null, 2)}\n`, "utf8");
  assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));

  writeFileSync(envPath, deploymentEnv("spark-rest", "redpanda"), "utf8");
  execFileSync("python3", baseArgs, { stdio: "pipe" });
}

function assertGateStatus(plan, policy, evidence, phase7, phase7Raw, mutate, name, expected) {
  const copy = structuredClone(evidence);
  mutate(copy);
  const report = evaluateRuntimeCutover({
    plan,
    policy,
    evidence: copy,
    phase7Report: phase7,
    phase7ReportSha256: sha256Hex(phase7Raw),
  });
  assert.equal(report.gates.find((gate) => gate.name === name)?.status, expected, name);
  if (expected === "failed") assert.equal(report.status, "rollback-required");
}

function approvedExamplePolicy(draft) {
  return {
    ...structuredClone(draft),
    policyId: "contract-test-approved",
    approvalStatus: "approved",
    approvedBy: "contract-test-only",
    approvedAt: "2026-07-14T00:00:00.000Z",
    changeTicket: "contract-test-change",
    minimumShadowRuns: 3,
    minimumObservationMinutes: 60,
    thresholds: {
      maxRowCountDelta: 0,
      maxQuarantineCountDelta: 0,
      maxErrorRate: 0.01,
      maxLag: 10,
      maxP95LatencyMs: 1000,
      maxCostUsd: 20,
    },
  };
}

function approvedPhase7Report() {
  const scenarioIds = [
    "small-steady", "ramp", "burst", "backlog", "capacity-cap", "scale-down", "multi-continuous", "continuous-with-batch",
    "kafka-disconnect", "s3-write-failure", "schema-quarantine-surge", "emr-job-failure", "backend-restart", "checkpoint-permission", "invalid-authentication", "poison-records",
  ];
  return {
    schemaVersion: "asklake.streaming-performance-report.v1",
    generatedAt: "2026-07-14T00:00:00.000Z",
    status: "passed",
    evidenceKind: "operational",
    profile: {
      profileId: "contract-test-phase7-approved",
      approvalStatus: "approved",
      approvedBy: "contract-test-only",
      approvedAt: "2026-07-14T00:00:00.000Z",
      minimumSuccessfulRuns: 1,
    },
    scenarioCoverage: { requiredScenarioIds: [...scenarioIds].sort(), missingScenarioIds: [] },
    scenarios: scenarioIds.map((scenarioId) => ({ scenarioId, status: "passed", runCount: 1 })),
  };
}

function deploymentEnv(sparkRuntime, kafkaRuntime) {
  return [
    "APP_ENV=production",
    "ASKLAKE_STORAGE_ENVIRONMENT=production",
    "AWS_REGION=ap-northeast-2",
    `ASKLAKE_SPARK_RUNTIME=${sparkRuntime}`,
    `ASKLAKE_KAFKA_RUNTIME=${kafkaRuntime}`,
    "",
  ].join("\n");
}

function gitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function parseArgs(values) {
  const result = { configOnly: false, evidencePath: null, outputDir: null, phase7ReportPath: null, planPath: null, policyPath: null, runId: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--config-only") result.configOnly = true;
    else if (value === "--evidence") result.evidencePath = requiredArg(values, ++index, value);
    else if (value === "--output-dir") result.outputDir = requiredArg(values, ++index, value);
    else if (value === "--phase7-report") result.phase7ReportPath = requiredArg(values, ++index, value);
    else if (value === "--plan") result.planPath = requiredArg(values, ++index, value);
    else if (value === "--policy") result.policyPath = requiredArg(values, ++index, value);
    else if (value === "--run-id") result.runId = requiredArg(values, ++index, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function requiredArg(values, index, flag) {
  const value = String(values[index] || "").trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function safeRunId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error("--run-id must be a safe identifier.");
  return normalized;
}
