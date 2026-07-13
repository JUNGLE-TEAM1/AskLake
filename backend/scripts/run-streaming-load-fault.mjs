import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  STREAMING_EVIDENCE_SCHEMA,
  normalizeStreamingEvidence,
  redactStreamingEvidence,
  validateStreamingPlan,
} from "../src/streamingPerformance.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planPath = path.join(backendDir, "fixtures", "performance", "streaming-phase7-plan.json");
const soakScript = path.join(backendDir, "scripts", "verify-kafka-continuous-soak.mjs");
const localScenarioDefaults = Object.freeze({
  "small-steady": {
    count: 2_000, rate: 250, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "none", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: false,
  },
  burst: {
    count: 5_000, rate: 5_000, batchSize: 500, partitions: 6, triggerSeconds: 2, maxOffsets: 1_000,
    fault: "none", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: false,
  },
  backlog: {
    count: 10_000, rate: 10_000, batchSize: 500, partitions: 6, triggerSeconds: 2, maxOffsets: 1_000,
    fault: "none", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: true,
  },
  "kafka-disconnect": {
    count: 5_000, rate: 500, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "kafka", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: false,
  },
  "s3-write-failure": {
    count: 5_000, rate: 500, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "minio", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: false,
  },
  "schema-quarantine-surge": {
    count: 5_000, rate: 500, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "none", malformedPercent: 40, schemaChange: true, startWorkerAfterProduce: false,
  },
  "backend-restart": {
    count: 5_000, rate: 500, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "backend", malformedPercent: 0, schemaChange: false, startWorkerAfterProduce: false,
  },
  "poison-records": {
    count: 5_000, rate: 500, batchSize: 100, partitions: 3, triggerSeconds: 2, maxOffsets: 500,
    fault: "none", malformedPercent: 75, schemaChange: false, startWorkerAfterProduce: false,
  },
});

const options = parseArgs(process.argv.slice(2));
const plan = validateStreamingPlan(readJson(options.planPath || planPath));
if (options.configOnly || process.argv.length === 2) verifyPlan(plan);
else if (options.prepareAws) prepareAwsEvidence(plan, options);
else runLocalScenario(plan, options);

function verifyPlan(value) {
  assert.equal(value.loadScenarios.length, 8);
  assert.equal(value.faultScenarios.length, 8);
  const scenarios = [...value.loadScenarios, ...value.faultScenarios];
  const localIds = scenarios.filter((item) => item.executor === "local-soak").map((item) => item.id).sort();
  assert.deepEqual(localIds, Object.keys(localScenarioDefaults).sort());
  for (const [id, config] of Object.entries(localScenarioDefaults)) {
    assert(config.count > 0, `${id} count`);
    assert(config.rate > 0, `${id} rate`);
    assert(config.maxOffsets > 0, `${id} maxOffsets`);
    assert(["none", "worker", "backend", "kafka", "minio"].includes(config.fault), `${id} fault`);
  }
  assert.throws(() => selectedScenario(value, "unknown"), /Unknown Phase 7 scenario/);
  console.log("Streaming Phase 7 load/fault execution plan verified without Docker or AWS side effects.");
}

function runLocalScenario(value, args) {
  if (process.env.ASKLAKE_RUN_STREAMING_LOAD_FAULT !== "true") {
    throw new Error("Set ASKLAKE_RUN_STREAMING_LOAD_FAULT=true to run the opt-in load/fault scenario.");
  }
  if (process.env.ASKLAKE_STREAMING_TEST_DEDICATED_ENVIRONMENT !== "true") {
    throw new Error("Set ASKLAKE_STREAMING_TEST_DEDICATED_ENVIRONMENT=true only after isolating the Compose test environment.");
  }
  const scenario = selectedScenario(value, args.scenarioId);
  if (scenario.executor !== "local-soak") {
    throw new Error(`Scenario ${scenario.id} is AWS staging-only. Use --prepare-aws ${scenario.id}; this runner will not create or mutate AWS resources.`);
  }
  const defaults = localScenarioDefaults[scenario.id];
  const config = overriddenConfig(defaults);
  const outputDir = outputDirectory(args.outputDir);
  const runId = safeRunId(args.runId || `${scenario.id}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [soakScript], {
    cwd: backendDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: soakEnvironment(config, value.namespacePrefix),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const failurePath = path.join(outputDir, `${runId}.failure.json`);
    writeFileSync(failurePath, `${JSON.stringify({
      schemaVersion: "asklake.streaming-load-fault-failure.v1",
      runId,
      scenarioId: scenario.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      error: compactFailure(result),
    }, null, 2)}\n`, "utf8");
    throw new Error(`Streaming scenario failed. Redacted evidence: ${failurePath}`);
  }
  const soak = parseSoakResult(result.stdout);
  const evidence = normalizeStreamingEvidence(localEvidence(runId, scenario, soak));
  const evidencePath = path.join(outputDir, `${runId}.evidence.json`);
  writeFileSync(evidencePath, `${JSON.stringify(redactStreamingEvidence(evidence), null, 2)}\n`, "utf8");
  console.log(`ASKLAKE_STREAMING_EVIDENCE=${evidencePath}`);
  console.log("Local evidence proves integrity/recovery only; it cannot approve AWS latency, autoscaling, or billed cost SLOs.");
}

function prepareAwsEvidence(value, args) {
  const scenario = selectedScenario(value, args.prepareAws);
  if (scenario.executor !== "aws-staging") {
    throw new Error(`Scenario ${scenario.id} uses the local soak runner; do not prepare it as AWS-only evidence.`);
  }
  const outputDir = outputDirectory(args.outputDir);
  const runId = safeRunId(args.runId || `${scenario.id}-replace-me`);
  const faultScenario = value.faultScenarios.some((item) => item.id === scenario.id);
  const template = {
    schemaVersion: STREAMING_EVIDENCE_SCHEMA,
    runId,
    scenarioId: scenario.id,
    runtime: "emr-serverless",
    startedAt: "REPLACE_WITH_ISO_TIMESTAMP",
    completedAt: "REPLACE_WITH_ISO_TIMESTAMP",
    environment: { name: "staging", region: "ap-northeast-2", sourceRevision: "REPLACE_WITH_GIT_SHA" },
    workload: { messageCount: 0, messageBytesAverage: 0, inputPattern: scenario.id },
    tuning: { topicPartitions: 0, triggerIntervalSeconds: 0, maxOffsetsPerTrigger: 0, maxExecutors: 0 },
    counts: { produced: 0, consumed: 0, stored: 0, quarantined: 0, replayed: 0, failed: 0, missing: 0, unexplainedDuplicates: 0 },
    throughputSamplesRowsPerSecond: [],
    lagSamples: [],
    executorSamples: [],
    latency: { aggregation: "worst-successful-batch-percentile", batchCount: 0, sampleCount: 0, timestampMissingCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, method: "kafka-record-timestamp-to-target-commit" },
    ...(faultScenario ? { fault: { injection: scenario.id, injected: null, expectedOutcomeObserved: null, recovered: null, failureCode: terminalFaultScenario(scenario.id) ? "REPLACE_WITH_CLASSIFIED_FAILURE_CODE" : null } } : {}),
    recovery: { backlogRecoverySeconds: null, faultRecoverySeconds: null },
    resources: { executorMin: null, executorMax: null, executorAverage: null, peakCpuVcpu: null, peakMemoryGb: null, cloudWatchMetricPeriodSeconds: 60 },
    emrJobRun: { applicationId: "REPLACE", jobRunId: "REPLACE", attempt: 1, totalExecutionDurationSeconds: 0, billedResourceUtilization: { vCPUHour: 0, memoryGBHour: 0, storageGBHour: 0 } },
    output: { bytes: 0, fileCount: 0, smallFileCount: 0, smallFileThresholdBytes: 16777216 },
    cost: { actualCostUsd: null, additionalCostUsd: 0, priceSnapshot: { region: "ap-northeast-2", architecture: "REPLACE_WITH_X86_64_OR_ARM64", currency: "USD", effectiveAt: "REPLACE_WITH_ISO_TIMESTAMP", sourceUrl: "https://aws.amazon.com/emr/pricing/", vCPUHourUsd: 0, memoryGBHourUsd: 0, storageGBHourUsd: 0 } },
  };
  const templatePath = path.join(outputDir, `${runId}.template.json`);
  writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  console.log(`ASKLAKE_STREAMING_AWS_EVIDENCE_TEMPLATE=${templatePath}`);
  console.log("Template creation does not run AWS. Replace every placeholder from the dedicated staging run before reporting.");
}

function localEvidence(runId, scenario, soak) {
  const containers = Object.values(soak.resourceUsage?.containers || {});
  const peakCpuPercent = containers.length ? Math.max(...containers.map((item) => Number(item.peakCpuPercent || 0))) : null;
  const peakMemoryBytes = containers.length ? Math.max(...containers.map((item) => Number(item.peakMemoryBytes || 0))) : null;
  const dataFault = ["schema-quarantine-surge", "poison-records"].includes(scenario.id);
  const faultScenario = ["kafka-disconnect", "s3-write-failure", "schema-quarantine-surge", "backend-restart", "poison-records"].includes(scenario.id);
  const faultInjected = dataFault
    ? Number(soak.tuning?.malformedPercent || 0) > 0
    : soak.faultInjected === true;
  const expectedOutcomeObserved = dataFault
    ? soak.quarantinedCount > 0 && soak.storedCount > 0
    : Number.isFinite(soak.recoveryMs);
  return {
    schemaVersion: STREAMING_EVIDENCE_SCHEMA,
    runId,
    scenarioId: scenario.id,
    runtime: "local-docker",
    startedAt: soak.startedAt,
    completedAt: soak.completedAt,
    environment: {
      name: "dedicated-local-compose",
      region: "local",
      sourceRevision: commandOutput("git", ["rev-parse", "HEAD"]),
    },
    workload: {
      messageCount: soak.producedCount,
      messageBytesAverage: soak.averageMessageBytes,
      inputPattern: scenario.id,
    },
    tuning: {
      topicPartitions: soak.tuning.partitionCount,
      triggerIntervalSeconds: soak.tuning.triggerIntervalSeconds,
      maxOffsetsPerTrigger: soak.tuning.maxOffsetsPerTrigger,
      producerRateRowsPerSecond: soak.tuning.rate,
      producerBatchSize: soak.tuning.producerBatchSize,
    },
    counts: {
      produced: soak.producedCount,
      consumed: soak.consumedCount,
      stored: soak.storedCount,
      quarantined: soak.quarantinedCount,
      replayed: soak.replayedCount,
      failed: 0,
      missing: soak.missingCount,
      unexplainedDuplicates: soak.duplicateCount,
    },
    throughputSamplesRowsPerSecond: [soak.finalThroughputRowsPerSecond, soak.peakThroughputRowsPerSecond].filter((value) => Number.isFinite(value)),
    averageThroughputRowsPerSecond: (soak.backlogRecoveryMs || soak.elapsedMs) > 0
      ? Number((soak.consumedCount / ((soak.backlogRecoveryMs || soak.elapsedMs) / 1000)).toFixed(3))
      : null,
    lagSamples: [soak.peakLag, soak.finalLag].filter((value) => Number.isFinite(value)),
    executorSamples: [],
    latency: soak.endToEndLatency || null,
    ...(faultScenario ? {
      fault: {
        injection: scenario.id,
        injected: faultInjected,
        expectedOutcomeObserved,
        recovered: dataFault ? soak.storedCount > 0 : Number.isFinite(soak.recoveryMs),
        failureCode: null,
      },
    } : {}),
    recovery: {
      backlogRecoverySeconds: Number.isFinite(soak.backlogRecoveryMs) ? soak.backlogRecoveryMs / 1000 : null,
      faultRecoverySeconds: Number.isFinite(soak.recoveryMs) ? soak.recoveryMs / 1000 : null,
    },
    resources: {
      executorMin: null,
      executorMax: null,
      executorAverage: null,
      peakCpuVcpu: Number.isFinite(peakCpuPercent) ? peakCpuPercent / 100 : null,
      peakMemoryGb: Number.isFinite(peakMemoryBytes) ? peakMemoryBytes / (1024 ** 3) : null,
      cloudWatchMetricPeriodSeconds: null,
    },
    output: { bytes: null, fileCount: null, smallFileCount: null, smallFileThresholdBytes: 16777216 },
    cost: { actualCostUsd: null, additionalCostUsd: 0, priceSnapshot: null },
  };
}

function selectedScenario(value, idValue) {
  const id = String(idValue || "").trim();
  if (!id) throw new Error("Pass --scenario <id> or --prepare-aws <id>.");
  const found = [...value.loadScenarios, ...value.faultScenarios].find((item) => item.id === id);
  if (!found) throw new Error(`Unknown Phase 7 scenario: ${id}`);
  return found;
}

function terminalFaultScenario(id) {
  return ["emr-job-failure", "checkpoint-permission", "invalid-authentication"].includes(id);
}

function overriddenConfig(defaults) {
  return {
    ...defaults,
    count: positiveEnvironment("ASKLAKE_STREAMING_TEST_COUNT", defaults.count),
    rate: positiveEnvironment("ASKLAKE_STREAMING_TEST_RATE", defaults.rate),
    batchSize: positiveEnvironment("ASKLAKE_STREAMING_TEST_PRODUCER_BATCH_SIZE", defaults.batchSize),
    partitions: positiveEnvironment("ASKLAKE_STREAMING_TEST_PARTITIONS", defaults.partitions),
    triggerSeconds: positiveEnvironment("ASKLAKE_STREAMING_TEST_TRIGGER_SECONDS", defaults.triggerSeconds),
    maxOffsets: positiveEnvironment("ASKLAKE_STREAMING_TEST_MAX_OFFSETS_PER_TRIGGER", defaults.maxOffsets),
  };
}

function soakEnvironment(config, namespacePrefix) {
  return {
    ...process.env,
    ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK: "true",
    ASKLAKE_CONTINUOUS_SOAK_COUNT: String(config.count),
    ASKLAKE_CONTINUOUS_SOAK_RATE: String(config.rate),
    ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE: String(config.batchSize),
    ASKLAKE_CONTINUOUS_SOAK_PARTITIONS: String(config.partitions),
    ASKLAKE_CONTINUOUS_SOAK_TRIGGER_SECONDS: String(config.triggerSeconds),
    ASKLAKE_CONTINUOUS_SOAK_MAX_OFFSETS_PER_TRIGGER: String(config.maxOffsets),
    ASKLAKE_CONTINUOUS_SOAK_MALFORMED_PERCENT: String(config.malformedPercent),
    ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE: String(config.schemaChange),
    ASKLAKE_CONTINUOUS_SOAK_FAULT: config.fault,
    ASKLAKE_CONTINUOUS_SOAK_FAULT_AFTER: String(Math.max(1, Math.floor(config.count / 2))),
    ASKLAKE_CONTINUOUS_SOAK_START_WORKER_AFTER_PRODUCE: String(config.startWorkerAfterProduce),
    ASKLAKE_CONTINUOUS_SOAK_RESOURCE_SAMPLING: "true",
    ASKLAKE_CONTINUOUS_SOAK_TOPIC_PREFIX: namespacePrefix,
  };
}

function parseSoakResult(stdout) {
  const marker = "ASKLAKE_CONTINUOUS_SOAK_RESULT=";
  const line = String(stdout || "").split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) throw new Error("Soak completed without ASKLAKE_CONTINUOUS_SOAK_RESULT evidence.");
  return JSON.parse(line.slice(marker.length));
}

function compactFailure(result) {
  return String(result.stderr || result.stdout || `process exited with status ${result.status}`)
    .replace(/\/Users\/[^/\s]+/g, "/Users/[USER]")
    .replace(/((?:authorization|access[_-]?key|secret|password|token)\s*[:=]\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s|]+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s|]+/gi, "[URL]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:[0-9]{2,5}\b/g, "[ENDPOINT]")
    .split(/\r?\n/).filter(Boolean).slice(-12).join(" | ").slice(0, 2_000);
}

function outputDirectory(value) {
  const output = path.resolve(value || path.join(backendDir, "tmp", "streaming-performance"));
  mkdirSync(output, { recursive: true });
  return output;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: backendDir, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "unavailable";
}

function positiveEnvironment(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
}

function parseArgs(values) {
  const result = { configOnly: false, outputDir: null, planPath: null, prepareAws: null, runId: null, scenarioId: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--config-only") result.configOnly = true;
    else if (value === "--output-dir") result.outputDir = requiredArg(values, ++index, value);
    else if (value === "--plan") result.planPath = requiredArg(values, ++index, value);
    else if (value === "--prepare-aws") result.prepareAws = requiredArg(values, ++index, value);
    else if (value === "--run-id") result.runId = requiredArg(values, ++index, value);
    else if (value === "--scenario") result.scenarioId = requiredArg(values, ++index, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (result.scenarioId && result.prepareAws) throw new Error("Pass either --scenario or --prepare-aws, not both.");
  return result;
}

function requiredArg(values, index, flag) {
  const value = String(values[index] || "").trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function safeRunId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error("runId must be a safe identifier.");
  return normalized;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
