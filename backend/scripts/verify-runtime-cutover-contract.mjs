import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const scriptPath = fileURLToPath(import.meta.url);
const backendDir = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(backendDir, "..");
const fixtureDir = path.join(backendDir, "fixtures", "runtime-cutover");
const defaultPlanPath = path.join(fixtureDir, "phase8-rollout-plan.json");
const defaultPolicyPath = path.join(fixtureDir, "phase8-cutover-policy.draft.json");
const defaultEvidencePath = path.join(fixtureDir, "phase8-cutover-evidence.example.json");
const gateScript = path.join(backendDir, "scripts", "verify-runtime-cutover-gate.py");

const args = parseArgs(process.argv.slice(2));
validateMode(args);
if (args.configOnly) verifyContract();
else if (args.testBundleDir) writeTestBundle(args.testBundleDir);
else generateReport(args);

function verifyContract() {
  verifyCliModes();
  const planArtifact = readArtifact(defaultPlanPath);
  const draftPolicyArtifact = readArtifact(defaultPolicyPath);
  const evidenceArtifact = readArtifact(defaultEvidencePath);
  const plan = planArtifact.value;
  const draftPolicy = draftPolicyArtifact.value;
  const evidence = evidenceArtifact.value;
  validateRuntimeCutoverPlan(plan);
  validateRuntimeCutoverPolicy(draftPolicy);
  const normalized = normalizeRuntimeCutoverEvidence(evidence);
  assert.notEqual(normalized.baseline.consumerGroup, normalized.candidate.consumerGroup);
  assert.notEqual(normalized.baseline.outputPrefix, normalized.candidate.outputPrefix);
  assert.notEqual(normalized.baseline.checkpointPath, normalized.candidate.checkpointPath);

  const revision = gitRevision();
  const timestamps = operationalTimestamps();
  const approvedPolicy = approvedExamplePolicy(draftPolicy, timestamps.approvedAt);
  const testEvidence = structuredClone(evidence);
  testEvidence.exampleOnly = false;
  testEvidence.environment.sourceRevision = revision;
  testEvidence.rollback.previousGoodRevision = revision;
  applyOperationalTimestamps(testEvidence, timestamps);
  const phase7 = approvedPhase7Report(timestamps.phase7ApprovedAt);
  const phase7Raw = jsonRaw(phase7);
  const passed = evaluateRuntimeCutover({
    plan,
    policy: approvedPolicy,
    evidence: testEvidence,
    phase7Report: phase7,
    phase7ReportSha256: sha256Hex(phase7Raw),
    sourceArtifacts: sourceArtifactsFor(plan, approvedPolicy, testEvidence, phase7Raw),
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
    sourceArtifacts: sourceArtifactsFor(plan, draftPolicy, testEvidence, phase7Raw),
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
    copy.shadowRuns[0].candidate.storedCount += 5;
    copy.shadowRuns[0].candidate.replayedCount += 5;
  }, "stored-count-delta", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.shadowRuns[0].candidate.valueChecksum = "abababababababababababababababababababababababababababababababab";
  }, "value-checksum-match", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.observation.maxLag = 11;
  }, "observation-max-lag", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.stageEvidence["aws-continuous-staging"].status = "not-run";
  }, "stage:aws-continuous-staging", "insufficient-evidence");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.stageEvidence["aws-batch-staging"].completedAt = new Date(Date.parse(copy.stageEvidence["docker-regression"].completedAt) - 1_000).toISOString();
  }, "chronology:stage-order", "failed");
  assertGateStatus(plan, approvedPolicy, testEvidence, phase7, phase7Raw, (copy) => {
    copy.observation.startedAt = new Date(Date.parse(copy.stageEvidence["small-workload-cutover"].completedAt) - 1_000).toISOString();
  }, "chronology:observation-after-small-workload", "failed");
  for (const requirement of ["requireSchemaMatch", "requireValueChecksumMatch", "requireQuarantineChecksumMatch"]) {
    assert.throws(
      () => evaluateRuntimeCutover({
        plan,
        policy: { ...structuredClone(approvedPolicy), [requirement]: false },
        evidence: testEvidence,
        phase7Report: phase7,
        phase7ReportSha256: sha256Hex(phase7Raw),
        sourceArtifacts: sourceArtifactsFor(plan, approvedPolicy, testEvidence, phase7Raw),
      }),
      new RegExp(`${requirement}=true`),
    );
  }
  const unapprovedPhase7 = structuredClone(phase7);
  unapprovedPhase7.profile.approvalStatus = "draft";
  const phase7Incomplete = evaluateRuntimeCutover({
    plan,
    policy: approvedPolicy,
    evidence: testEvidence,
    phase7Report: unapprovedPhase7,
    phase7ReportSha256: sha256Hex(jsonRaw(unapprovedPhase7)),
    sourceArtifacts: sourceArtifactsFor(plan, approvedPolicy, testEvidence, jsonRaw(unapprovedPhase7)),
  });
  assert.equal(phase7Incomplete.status, "insufficient-evidence");
  const incompleteCoveragePhase7 = structuredClone(phase7);
  incompleteCoveragePhase7.scenarios.pop();
  incompleteCoveragePhase7.scenarioCoverage.missingScenarioIds = ["small-steady"];
  const incompleteCoverageRaw = jsonRaw(incompleteCoveragePhase7);
  const incompleteCoverageReport = evaluateRuntimeCutover({
    plan,
    policy: approvedPolicy,
    evidence: testEvidence,
    phase7Report: incompleteCoveragePhase7,
    phase7ReportSha256: sha256Hex(incompleteCoverageRaw),
    sourceArtifacts: sourceArtifactsFor(plan, approvedPolicy, testEvidence, incompleteCoverageRaw),
  });
  assert.equal(incompleteCoverageReport.status, "insufficient-evidence");
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

  verifyPythonGate({ report: passed, phase7Raw, revision, plan, policy: approvedPolicy, evidence: testEvidence });
  console.log("Runtime cutover promotion and rollback contract verified.");
}

function verifyCliModes() {
  assert.throws(() => execFileSync(process.execPath, [scriptPath], { cwd: repositoryRoot, stdio: "pipe" }));
  assert.throws(() => execFileSync(process.execPath, [scriptPath, "--config-only", "--policy", defaultPolicyPath], { cwd: repositoryRoot, stdio: "pipe" }));
}

function generateReport(options) {
  if (!options.policyPath) throw new Error("Pass --policy <path>.");
  if (!options.evidencePath) throw new Error("Pass --evidence <path>.");
  if (!options.phase7ReportPath) throw new Error("Pass --phase7-report <path>.");
  const planArtifact = readArtifact(path.resolve(options.planPath || defaultPlanPath));
  const policyArtifact = readArtifact(path.resolve(options.policyPath));
  const evidenceArtifact = readArtifact(path.resolve(options.evidencePath));
  const phase7Artifact = readArtifact(path.resolve(options.phase7ReportPath));
  const plan = planArtifact.value;
  const policy = policyArtifact.value;
  const evidence = evidenceArtifact.value;
  const phase7Report = phase7Artifact.value;
  validateRuntimeCutoverPlan(plan);
  const report = evaluateRuntimeCutover({
    plan,
    policy,
    evidence,
    phase7Report,
    phase7ReportSha256: phase7Artifact.sha256,
    sourceArtifacts: sourceArtifactsFromArtifacts({ planArtifact, policyArtifact, evidenceArtifact, phase7Artifact }),
  });
  validateRepositoryRollback(report.rollback);
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

function verifyPythonGate({ report, phase7Raw, revision, plan, policy, evidence }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "asklake-runtime-cutover-"));
  try {
    const reportPath = path.join(tempDir, "cutover.json");
    const phase7Path = path.join(tempDir, "phase7.json");
    const planPath = path.join(tempDir, "plan.json");
    const policyPath = path.join(tempDir, "policy.json");
    const evidencePath = path.join(tempDir, "evidence.json");
    const envPath = path.join(tempDir, "deploy.env");
    const reportRaw = jsonRaw(report);
    const planRaw = jsonRaw(plan);
    const policyRaw = jsonRaw(policy);
    const evidenceRaw = jsonRaw(evidence);
    writeFileSync(reportPath, reportRaw);
    writeFileSync(phase7Path, phase7Raw);
    writeFileSync(planPath, planRaw);
    writeFileSync(policyPath, policyRaw);
    writeFileSync(evidencePath, evidenceRaw);
    writeFileSync(envPath, deploymentEnv("emr-serverless", "msk"), "utf8");
    const baseArgs = [gateScript, "--report", reportPath, "--plan", planPath, "--policy", policyPath, "--evidence", evidencePath, "--phase7-report", phase7Path, "--env-file", envPath, "--repository-root", repositoryRoot];
    execFileSync("python3", baseArgs, { stdio: "pipe" });

    const wrongRevision = structuredClone(report);
    wrongRevision.target.sourceRevision = revision === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40);
    writeFileSync(reportPath, jsonRaw(wrongRevision));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));

    writeFileSync(reportPath, reportRaw);
    writeFileSync(planPath, Buffer.concat([planRaw, Buffer.from(" ")]));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));
    writeFileSync(planPath, planRaw);

    writeFileSync(policyPath, Buffer.concat([policyRaw, Buffer.from(" ")]));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));
    writeFileSync(policyPath, policyRaw);

    writeFileSync(phase7Path, Buffer.concat([phase7Raw, Buffer.from(" ")]));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));
    writeFileSync(phase7Path, phase7Raw);

    writeFileSync(evidencePath, Buffer.concat([evidenceRaw, Buffer.from(" ")]));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));
    writeFileSync(evidencePath, evidenceRaw);

    const missingGate = structuredClone(report);
    missingGate.gates.pop();
    writeFileSync(reportPath, jsonRaw(missingGate));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));

    const futureTimestamp = new Date(Date.now() + 3_600_000).toISOString();
    const futureEvidence = structuredClone(evidence);
    futureEvidence.stageEvidence["small-workload-cutover"].completedAt = futureTimestamp;
    const futureEvidenceRaw = jsonRaw(futureEvidence);
    writeFileSync(evidencePath, futureEvidenceRaw);
    const futureStage = structuredClone(report);
    futureStage.stageEvidence["small-workload-cutover"].completedAt = futureTimestamp;
    futureStage.sourceArtifacts.evidence.sha256 = sha256Hex(futureEvidenceRaw);
    writeFileSync(reportPath, jsonRaw(futureStage));
    assert.throws(() => execFileSync("python3", baseArgs, { stdio: "pipe" }));

    writeFileSync(evidencePath, evidenceRaw);
    writeFileSync(reportPath, reportRaw);

    writeFileSync(envPath, deploymentEnv("spark-rest", "redpanda"), "utf8");
    execFileSync("python3", baseArgs, { stdio: "pipe" });
  } finally {
    const expectedPrefix = path.join(os.tmpdir(), "asklake-runtime-cutover-");
    if (!tempDir.startsWith(expectedPrefix)) throw new Error(`Refusing to remove unexpected temp directory: ${tempDir}`);
    rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(existsSync(tempDir), false);
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
    sourceArtifacts: sourceArtifactsFor(plan, policy, copy, phase7Raw),
  });
  assert.equal(report.gates.find((gate) => gate.name === name)?.status, expected, name);
  if (expected === "failed") assert.equal(report.status, "rollback-required");
}

function approvedExamplePolicy(draft, approvedAt) {
  return {
    ...structuredClone(draft),
    policyId: "contract-test-approved",
    approvalStatus: "approved",
    approvedBy: "contract-test-only",
    approvedAt,
    changeTicket: "contract-test-change",
    minimumShadowRuns: 3,
    minimumObservationMinutes: 60,
    thresholds: {
      maxStoredCountDelta: 0,
      maxQuarantineCountDelta: 0,
      maxErrorRate: 0.01,
      maxLag: 10,
      maxP95LatencyMs: 1000,
      maxCostUsd: 20,
    },
  };
}

function approvedPhase7Report(approvedAt) {
  const scenarioIds = [
    "small-steady", "ramp", "burst", "backlog", "capacity-cap", "scale-down", "multi-continuous", "continuous-with-batch",
    "kafka-disconnect", "s3-write-failure", "schema-quarantine-surge", "emr-job-failure", "backend-restart", "checkpoint-permission", "invalid-authentication", "poison-records",
  ];
  return {
    schemaVersion: "asklake.streaming-performance-report.v1",
    generatedAt: approvedAt,
    status: "passed",
    evidenceKind: "operational",
    profile: {
      profileId: "contract-test-phase7-approved",
      approvalStatus: "approved",
      approvedBy: "contract-test-only",
      approvedAt,
      minimumSuccessfulRuns: 1,
    },
    scenarioCoverage: { requiredScenarioIds: [...scenarioIds].sort(), missingScenarioIds: [] },
    scenarios: scenarioIds.map((scenarioId) => ({
      scenarioId,
      status: "passed",
      runCount: 1,
      configurationFingerprints: ["a".repeat(64)],
      summary: {},
      gates: [{ name: "repeat-count", status: "passed", actual: 1, target: 1, detail: "contract fixture" }],
      runs: [{
        runId: `${scenarioId}-001`,
        status: "passed",
        gates: [{ name: "integrity", status: "passed", actual: true, target: true, detail: "contract fixture" }],
      }],
    })),
  };
}

function operationalTimestamps() {
  const anchor = Date.now() - 60_000;
  const atHoursBefore = (hours) => new Date(anchor - hours * 3_600_000).toISOString();
  return {
    phase7ApprovedAt: atHoursBefore(10),
    dockerRegressionAt: atHoursBefore(9),
    awsBatchAt: atHoursBefore(8),
    awsContinuousAt: atHoursBefore(7),
    smallWorkloadAt: atHoursBefore(6),
    observationStartedAt: atHoursBefore(5),
    observationCompletedAt: atHoursBefore(3),
    rollbackTestedAt: atHoursBefore(2),
    approvedAt: atHoursBefore(1),
  };
}

function applyOperationalTimestamps(evidence, timestamps) {
  evidence.stageEvidence["docker-regression"].completedAt = timestamps.dockerRegressionAt;
  evidence.stageEvidence["aws-batch-staging"].completedAt = timestamps.awsBatchAt;
  evidence.stageEvidence["aws-continuous-staging"].completedAt = timestamps.awsContinuousAt;
  evidence.stageEvidence["small-workload-cutover"].completedAt = timestamps.smallWorkloadAt;
  evidence.observation.startedAt = timestamps.observationStartedAt;
  evidence.observation.completedAt = timestamps.observationCompletedAt;
  evidence.rollback.lastTestedAt = timestamps.rollbackTestedAt;
}

function buildOperationalBundle() {
  const plan = readArtifact(defaultPlanPath).value;
  const draftPolicy = readArtifact(defaultPolicyPath).value;
  const evidence = readArtifact(defaultEvidencePath).value;
  const timestamps = operationalTimestamps();
  const revision = gitRevision();
  const policy = approvedExamplePolicy(draftPolicy, timestamps.approvedAt);
  evidence.exampleOnly = false;
  evidence.environment.sourceRevision = revision;
  evidence.rollback.previousGoodRevision = revision;
  applyOperationalTimestamps(evidence, timestamps);
  const phase7 = approvedPhase7Report(timestamps.phase7ApprovedAt);
  const planRaw = jsonRaw(plan);
  const policyRaw = jsonRaw(policy);
  const evidenceRaw = jsonRaw(evidence);
  const phase7Raw = jsonRaw(phase7);
  const report = evaluateRuntimeCutover({
    plan,
    policy,
    evidence,
    phase7Report: phase7,
    phase7ReportSha256: sha256Hex(phase7Raw),
    sourceArtifacts: sourceArtifactsFor(plan, policy, evidence, phase7Raw),
  });
  assert.equal(report.status, "promotion-ready");
  validateRepositoryRollback(report.rollback);
  return { planRaw, policyRaw, evidenceRaw, phase7Raw, reportRaw: jsonRaw(report), report };
}

function writeTestBundle(directoryValue) {
  const outputDir = path.resolve(directoryValue);
  const bundle = buildOperationalBundle();
  mkdirSync(outputDir, { recursive: true });
  for (const [name, raw] of Object.entries({ plan: bundle.planRaw, policy: bundle.policyRaw, evidence: bundle.evidenceRaw, phase7: bundle.phase7Raw, report: bundle.reportRaw })) {
    writeFileSync(path.join(outputDir, `${name}.json`), raw);
  }
  console.log(`ASKLAKE_RUNTIME_CUTOVER_TEST_BUNDLE=${outputDir}`);
}

function validateRepositoryRollback(rollback) {
  const revision = rollback.previousGoodRevision;
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: repositoryRoot, stdio: "pipe" });
  execFileSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], { cwd: repositoryRoot, stdio: "pipe" });
  const runbookPath = path.resolve(repositoryRoot, rollback.runbookRef.split("#", 1)[0]);
  if (!runbookPath.startsWith(`${repositoryRoot}${path.sep}`) || !existsSync(runbookPath) || !statSync(runbookPath).isFile()) {
    throw new Error(`Rollback runbook does not exist inside the repository: ${rollback.runbookRef}`);
  }
}

function sourceArtifactsFor(plan, policy, evidence, phase7Raw) {
  return {
    plan: { sha256: sha256Hex(jsonRaw(plan)) },
    policy: { sha256: sha256Hex(jsonRaw(policy)) },
    evidence: { sha256: sha256Hex(jsonRaw(evidence)) },
    phase7: { sha256: sha256Hex(phase7Raw) },
  };
}

function sourceArtifactsFromArtifacts({ planArtifact, policyArtifact, evidenceArtifact, phase7Artifact }) {
  return {
    plan: { sha256: planArtifact.sha256 },
    policy: { sha256: policyArtifact.sha256 },
    evidence: { sha256: evidenceArtifact.sha256 },
    phase7: { sha256: phase7Artifact.sha256 },
  };
}

function jsonRaw(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readArtifact(filePath) {
  const raw = readFileSync(filePath);
  return { raw, sha256: sha256Hex(raw), value: JSON.parse(raw.toString("utf8")) };
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
  const result = { configOnly: false, evidencePath: null, outputDir: null, phase7ReportPath: null, planPath: null, policyPath: null, runId: null, testBundleDir: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--config-only") result.configOnly = true;
    else if (value === "--evidence") result.evidencePath = requiredArg(values, ++index, value);
    else if (value === "--output-dir") result.outputDir = requiredArg(values, ++index, value);
    else if (value === "--phase7-report") result.phase7ReportPath = requiredArg(values, ++index, value);
    else if (value === "--plan") result.planPath = requiredArg(values, ++index, value);
    else if (value === "--policy") result.policyPath = requiredArg(values, ++index, value);
    else if (value === "--run-id") result.runId = requiredArg(values, ++index, value);
    else if (value === "--write-test-bundle") result.testBundleDir = requiredArg(values, ++index, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function validateMode(options) {
  const reportOptions = [options.evidencePath, options.outputDir, options.phase7ReportPath, options.planPath, options.policyPath, options.runId].filter(Boolean);
  if (options.configOnly && (reportOptions.length || options.testBundleDir)) {
    throw new Error("--config-only cannot be combined with report generation options.");
  }
  if (options.testBundleDir && reportOptions.length) {
    throw new Error("--write-test-bundle cannot be combined with report generation options.");
  }
}

function requiredArg(values, index, flag) {
  const value = String(values[index] || "").trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function safeRunId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error("--run-id must be a safe identifier.");
  return normalized;
}
