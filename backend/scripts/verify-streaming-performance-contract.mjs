import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STREAMING_REPORT_SCHEMA,
  evaluateStreamingCampaign,
  evaluateStreamingEvidence,
  normalizeStreamingEvidence,
  redactStreamingEvidence,
  renderStreamingCampaignMarkdown,
  validateStreamingPlan,
  validateStreamingProfile,
} from "../src/streamingPerformance.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(backendDir, "fixtures", "performance");
const defaultPlanPath = path.join(fixtureDir, "streaming-phase7-plan.json");
const defaultProfilePath = path.join(fixtureDir, "streaming-slo-profile.draft.json");
const defaultEvidencePath = path.join(fixtureDir, "streaming-evidence.example.json");

const args = parseArgs(process.argv.slice(2));
if (args.configOnly || process.argv.length === 2) {
  verifyContract();
} else {
  generateReport(args);
}

function verifyContract() {
  const plan = readJson(defaultPlanPath);
  const draftProfile = readJson(defaultProfilePath);
  const evidence = readJson(defaultEvidencePath);
  validateStreamingPlan(plan);
  validateStreamingProfile(draftProfile);
  const normalized = normalizeStreamingEvidence(evidence);
  assert.equal(normalized.metrics.finalLag, 0);
  assert.equal(normalized.metrics.p95EndToEndLatencyMs, 900);
  assert.equal(normalized.metrics.costUsd, 0.0806);
  assert.equal(normalized.latency.aggregation, "worst-successful-batch-percentile");
  assert.equal(normalized.latency.batchCount, 24);
  assert.equal(normalized.latency.timestampMissingCount, 0);

  const unsupportedLatencyAggregation = structuredClone(evidence);
  unsupportedLatencyAggregation.runId = "example-unsupported-latency-aggregation";
  unsupportedLatencyAggregation.latency.aggregation = "global-percentile-claimed-without-raw-samples";
  assert.throws(
    () => normalizeStreamingEvidence(unsupportedLatencyAggregation),
    /latency\.aggregation must be worst-successful-batch-percentile/,
  );

  const approvedProfile = approvedExampleProfile(draftProfile);
  const passed = evaluateStreamingEvidence(approvedProfile, evidence);
  assert.equal(passed.status, "passed");
  assert(passed.gates.every((gate) => gate.status === "passed"));

  const draft = evaluateStreamingEvidence(draftProfile, evidence);
  assert.equal(draft.status, "insufficient-evidence");
  assert(draft.gates.some((gate) => gate.name === "profile-approval" && gate.status === "insufficient-evidence"));

  const duplicate = structuredClone(evidence);
  duplicate.runId = "example-duplicate";
  duplicate.counts.stored += 1;
  duplicate.counts.unexplainedDuplicates = 1;
  const duplicateResult = evaluateStreamingEvidence(approvedProfile, duplicate);
  assert.equal(duplicateResult.status, "failed");
  assert(duplicateResult.gates.some((gate) => gate.name === "unexplained-duplicates" && gate.status === "failed"));

  const missingCostEvidence = structuredClone(evidence);
  missingCostEvidence.runId = "example-no-billed-resource";
  delete missingCostEvidence.emrJobRun.billedResourceUtilization;
  const incompleteResult = evaluateStreamingEvidence(approvedProfile, missingCostEvidence);
  assert.equal(incompleteResult.status, "insufficient-evidence");
  assert(incompleteResult.gates.some((gate) => gate.name === "evidence:billedResourceUtilization" && gate.status === "insufficient-evidence"));

  const emptyBilledResource = structuredClone(evidence);
  emptyBilledResource.runId = "example-empty-billed-resource";
  emptyBilledResource.emrJobRun.billedResourceUtilization = {};
  assert.throws(() => normalizeStreamingEvidence(emptyBilledResource), /vCPUHour must be a non-negative number/);

  const mismatchedPriceRegion = structuredClone(evidence);
  mismatchedPriceRegion.runId = "example-mismatched-price-region";
  mismatchedPriceRegion.cost.priceSnapshot.region = "us-east-1";
  assert.throws(() => normalizeStreamingEvidence(mismatchedPriceRegion), /cost\.priceSnapshot\.region must be ap-northeast-2/);

  const missingCloudWatchSamples = structuredClone(evidence);
  missingCloudWatchSamples.runId = "example-no-cloudwatch-samples";
  missingCloudWatchSamples.executorSamples = [];
  const missingCloudWatchResult = evaluateStreamingEvidence(approvedProfile, missingCloudWatchSamples);
  assert(missingCloudWatchResult.gates.some((gate) => gate.name === "evidence:cloudWatchMetrics" && gate.status === "insufficient-evidence"));

  const wrongEnvironment = structuredClone(evidence);
  wrongEnvironment.runId = "example-wrong-environment";
  wrongEnvironment.environment.name = "production";
  const wrongEnvironmentResult = evaluateStreamingEvidence(approvedProfile, wrongEnvironment);
  assert(wrongEnvironmentResult.gates.some((gate) => gate.name === "profile-environment" && gate.status === "failed"));

  const faultProfile = {
    ...approvedProfile,
    profileId: "contract-test-fault-approved",
    scenarioThresholds: { "kafka-disconnect": { maxFaultRecoverySeconds: 10, maxFinalLag: 0 } },
  };
  const faultEvidence = structuredClone(evidence);
  faultEvidence.runId = "example-kafka-disconnect";
  faultEvidence.scenarioId = "kafka-disconnect";
  faultEvidence.recovery.faultRecoverySeconds = 5;
  faultEvidence.fault = { injection: "kafka-disconnect", injected: true, expectedOutcomeObserved: true, recovered: true, failureCode: null };
  const faultResult = evaluateStreamingEvidence(faultProfile, faultEvidence);
  assert.equal(faultResult.status, "passed");
  delete faultEvidence.fault;
  const missingFaultResult = evaluateStreamingEvidence(faultProfile, faultEvidence);
  assert.equal(missingFaultResult.status, "insufficient-evidence");

  const untrustedPrice = structuredClone(evidence);
  untrustedPrice.runId = "example-untrusted-price";
  untrustedPrice.cost.priceSnapshot.sourceUrl = "https://example.com/pricing";
  assert.throws(() => normalizeStreamingEvidence(untrustedPrice), /official AWS HTTPS URL/);

  assert.throws(
    () => normalizeStreamingEvidence({ ...evidence, authorization: "Bearer secret" }),
    /Sensitive key is not allowed/,
  );
  assert.deepEqual(
    redactStreamingEvidence({ nested: { password: "secret", safe: "value" } }),
    { nested: { password: "[REDACTED]", safe: "value" } },
  );
  assert.throws(
    () => normalizeStreamingEvidence({ ...evidence, note: "Bearer should-not-be-recorded" }),
    /Sensitive value is not allowed/,
  );

  const repeated = [1, 2, 3].map((index) => ({ ...structuredClone(evidence), runId: `example-backlog-00${index}` }));
  const campaign = evaluateStreamingCampaign({ ...approvedProfile, minimumSuccessfulRuns: 3 }, repeated);
  assert.equal(campaign.schemaVersion, STREAMING_REPORT_SCHEMA);
  assert.equal(campaign.status, "passed");
  assert.equal(campaign.scenarios[0].runCount, 3);

  const drifted = structuredClone(repeated[2]);
  drifted.tuning.maxExecutors = 21;
  const incomparable = evaluateStreamingCampaign({ ...approvedProfile, minimumSuccessfulRuns: 3 }, [repeated[0], repeated[1], drifted]);
  assert.equal(incomparable.status, "failed");
  assert(incomparable.scenarios[0].gates.some((gate) => gate.name === "comparable-configuration" && gate.status === "failed"));

  const duplicatedRun = evaluateStreamingCampaign({ ...approvedProfile, minimumSuccessfulRuns: 3 }, [repeated[0], repeated[1], repeated[1]]);
  assert.equal(duplicatedRun.status, "failed");
  assert(duplicatedRun.scenarios[0].gates.some((gate) => gate.name === "unique-run-identity" && gate.status === "failed"));

  const markdown = renderStreamingCampaignMarkdown(campaign);
  assert(markdown.includes("Kafka·Spark Phase 7 성능 검증 리포트"));
  assert(markdown.includes("example-backlog-001"));
  assert(markdown.includes("최종 판정: **passed**"));
  console.log("Streaming load/fault/cost performance contract verified.");
}

function generateReport(options) {
  const plan = readJson(options.planPath || defaultPlanPath);
  validateStreamingPlan(plan);
  if (!options.profilePath) throw new Error("Pass --profile <path>.");
  if (!options.evidencePaths.length) throw new Error("Pass --evidence <path> at least once.");
  const profile = readJson(path.resolve(options.profilePath));
  const evidence = options.evidencePaths.map((entry) => readJson(path.resolve(entry)));
  const plannedScenarioIds = new Set([...plan.loadScenarios, ...plan.faultScenarios].map((scenario) => scenario.id));
  for (const item of evidence) {
    if (!plannedScenarioIds.has(item?.scenarioId)) {
      throw new Error(`Evidence scenario is not declared by the Phase 7 plan: ${item?.scenarioId || "<missing>"}`);
    }
  }
  const report = evaluateStreamingCampaign(profile, evidence);
  const outputDir = path.resolve(options.outputDir || path.join(backendDir, "tmp", "streaming-performance"));
  const runId = safeRunId(options.runId || `phase7-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${runId}.json`);
  const markdownPath = path.join(outputDir, `${runId}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(redactStreamingEvidence(report), null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderStreamingCampaignMarkdown(report), "utf8");
  console.log(`ASKLAKE_STREAMING_PERFORMANCE_STATUS=${report.status}`);
  console.log(`ASKLAKE_STREAMING_PERFORMANCE_JSON=${jsonPath}`);
  console.log(`ASKLAKE_STREAMING_PERFORMANCE_MARKDOWN=${markdownPath}`);
  if (report.status === "failed") process.exitCode = 1;
  if (report.status === "insufficient-evidence") process.exitCode = 2;
}

function approvedExampleProfile(draft) {
  return {
    ...structuredClone(draft),
    profileId: "contract-test-approved",
    approvalStatus: "approved",
    approvedBy: "contract-test-only",
    approvedAt: "2026-07-14T00:00:00.000Z",
    minimumSuccessfulRuns: 1,
    scenarioThresholds: {
      backlog: {
        minAverageThroughputRowsPerSecond: 800,
        maxP95EndToEndLatencyMs: 1_000,
        maxBacklogRecoverySeconds: 120,
        maxFinalLag: 0,
        maxCostUsd: 0.1,
      },
    },
  };
}

function parseArgs(values) {
  const result = {
    configOnly: false,
    evidencePaths: [],
    outputDir: null,
    planPath: null,
    profilePath: null,
    runId: null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--config-only") result.configOnly = true;
    else if (value === "--evidence") result.evidencePaths.push(requiredArg(values, ++index, value));
    else if (value === "--output-dir") result.outputDir = requiredArg(values, ++index, value);
    else if (value === "--plan") result.planPath = requiredArg(values, ++index, value);
    else if (value === "--profile") result.profilePath = requiredArg(values, ++index, value);
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error("--run-id must be a safe identifier.");
  }
  return normalized;
}
