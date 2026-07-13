import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soakScript = path.join(backendDir, "scripts", "verify-kafka-continuous-soak.mjs");
const scenarios = Object.freeze({
  steady: {
    description: "일정한 입력에서 lag가 지속적으로 증가하지 않는지 측정한다.",
    count: 2_000,
    rate: 250,
    batchSize: 100,
    triggerSeconds: 2,
    maxOffsetsPerTrigger: 500,
    fault: "none",
    startWorkerAfterProduce: false,
  },
  burst: {
    description: "짧은 고속 입력 뒤 peak lag와 정상 회복 시간을 측정한다.",
    count: 5_000,
    rate: 5_000,
    batchSize: 500,
    triggerSeconds: 2,
    maxOffsetsPerTrigger: 1_000,
    fault: "none",
    startWorkerAfterProduce: false,
  },
  backlog: {
    description: "worker 시작 전에 적재한 backlog를 earliest checkpoint에서 해소하는 시간을 측정한다.",
    count: 10_000,
    rate: 10_000,
    batchSize: 500,
    triggerSeconds: 2,
    maxOffsetsPerTrigger: 1_000,
    fault: "none",
    startWorkerAfterProduce: true,
  },
  "worker-recovery": {
    description: "처리 도중 Spark worker 장애를 주입하고 checkpoint 복구 시간과 정합성을 측정한다.",
    count: 5_000,
    rate: 500,
    batchSize: 100,
    triggerSeconds: 2,
    maxOffsetsPerTrigger: 500,
    fault: "worker",
    faultAfter: 2_500,
    startWorkerAfterProduce: false,
  },
});

const configOnly = process.argv.includes("--config-only")
  || process.env.ASKLAKE_CONTINUOUS_BASELINE_CONFIG_ONLY === "true";

if (configOnly) {
  verifyConfigurationContract();
} else {
  runBaseline();
}

function runBaseline() {
  if (process.env.ASKLAKE_RUN_KAFKA_CONTINUOUS_BASELINE !== "true") {
    throw new Error(
      "Set ASKLAKE_RUN_KAFKA_CONTINUOUS_BASELINE=true for the opt-in baseline run, "
      + "or use npm run verify:kafka-continuous-baseline:config for configuration-only verification.",
    );
  }
  const config = resolveConfig(process.env);
  const outputDir = path.resolve(
    process.env.ASKLAKE_CONTINUOUS_BASELINE_OUTPUT_DIR
      || path.join(backendDir, "tmp", "kafka-continuous-baseline"),
  );
  mkdirSync(outputDir, { recursive: true });
  const runId = safeRunId(
    process.env.ASKLAKE_CONTINUOUS_BASELINE_RUN_ID
      || `${config.scenario}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [soakScript], {
    cwd: backendDir,
    encoding: "utf8",
    env: soakEnvironment(config),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const reportPath = path.join(outputDir, `${runId}.json`);
  const markdownPath = path.join(outputDir, `${runId}.md`);
  if (result.status !== 0) {
    const failure = {
      schemaVersion: "asklake.kafka-spark-baseline.v1",
      runId,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      scenario: publicScenario(config),
      failure: compactFailure(result),
    };
    writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    writeFileSync(markdownPath, renderMarkdown(failure), "utf8");
    throw new Error(`Kafka Continuous baseline failed. Evidence: ${reportPath}`);
  }

  const measurements = parseSoakResult(result.stdout);
  validateMeasurements(measurements);
  const report = {
    schemaVersion: "asklake.kafka-spark-baseline.v1",
    runId,
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRevision: gitRevision(),
    environment: environmentEvidence(config),
    scenario: publicScenario(config),
    measurements,
    evaluation: {
      dataIntegrity: "passed",
      performanceTarget: "not-set-phase0",
      note: "Phase 0 records measured evidence; throughput and latency SLOs require an approved target and cost envelope.",
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  console.log(`ASKLAKE_CONTINUOUS_BASELINE_JSON=${reportPath}`);
  console.log(`ASKLAKE_CONTINUOUS_BASELINE_MARKDOWN=${markdownPath}`);
}

function resolveConfig(env) {
  const scenario = String(env.ASKLAKE_CONTINUOUS_BASELINE_SCENARIO || "steady").trim().toLowerCase();
  const defaults = scenarios[scenario];
  if (!defaults) {
    throw new Error(`ASKLAKE_CONTINUOUS_BASELINE_SCENARIO must be one of: ${Object.keys(scenarios).join(", ")}`);
  }
  const config = {
    scenario,
    description: defaults.description,
    inputPath: optionalString(env.ASKLAKE_CONTINUOUS_BASELINE_INPUT),
    count: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_COUNT, defaults.count, "ASKLAKE_CONTINUOUS_BASELINE_COUNT"),
    rate: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_RATE, defaults.rate, "ASKLAKE_CONTINUOUS_BASELINE_RATE"),
    batchSize: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_BATCH_SIZE, defaults.batchSize, "ASKLAKE_CONTINUOUS_BASELINE_BATCH_SIZE"),
    partitionCount: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_PARTITIONS, 1, "ASKLAKE_CONTINUOUS_BASELINE_PARTITIONS"),
    triggerSeconds: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_TRIGGER_SECONDS, defaults.triggerSeconds, "ASKLAKE_CONTINUOUS_BASELINE_TRIGGER_SECONDS"),
    maxOffsetsPerTrigger: positiveInteger(
      env.ASKLAKE_CONTINUOUS_BASELINE_MAX_OFFSETS_PER_TRIGGER,
      defaults.maxOffsetsPerTrigger,
      "ASKLAKE_CONTINUOUS_BASELINE_MAX_OFFSETS_PER_TRIGGER",
    ),
    malformedPercent: percentage(env.ASKLAKE_CONTINUOUS_BASELINE_MALFORMED_PERCENT, 0),
    schemaChange: booleanValue(env.ASKLAKE_CONTINUOUS_BASELINE_SCHEMA_CHANGE, false, "ASKLAKE_CONTINUOUS_BASELINE_SCHEMA_CHANGE"),
    fault: String(env.ASKLAKE_CONTINUOUS_BASELINE_FAULT || defaults.fault).trim().toLowerCase(),
    faultAfter: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_FAULT_AFTER, defaults.faultAfter || Math.ceil(defaults.count / 2), "ASKLAKE_CONTINUOUS_BASELINE_FAULT_AFTER"),
    faultDurationMs: positiveInteger(env.ASKLAKE_CONTINUOUS_BASELINE_FAULT_DURATION_MS, 5_000, "ASKLAKE_CONTINUOUS_BASELINE_FAULT_DURATION_MS"),
    startWorkerAfterProduce: booleanValue(
      env.ASKLAKE_CONTINUOUS_BASELINE_START_WORKER_AFTER_PRODUCE,
      defaults.startWorkerAfterProduce,
      "ASKLAKE_CONTINUOUS_BASELINE_START_WORKER_AFTER_PRODUCE",
    ),
    compaction: booleanValue(env.ASKLAKE_CONTINUOUS_BASELINE_COMPACT, false, "ASKLAKE_CONTINUOUS_BASELINE_COMPACT"),
    resourceSampling: booleanValue(
      env.ASKLAKE_CONTINUOUS_BASELINE_RESOURCE_SAMPLING,
      true,
      "ASKLAKE_CONTINUOUS_BASELINE_RESOURCE_SAMPLING",
    ),
    costContext: singleLineValue(env.ASKLAKE_CONTINUOUS_BASELINE_COST_CONTEXT, "local-unpriced", "ASKLAKE_CONTINUOUS_BASELINE_COST_CONTEXT"),
  };
  if (!["none", "worker", "backend", "kafka", "minio"].includes(config.fault)) {
    throw new Error("ASKLAKE_CONTINUOUS_BASELINE_FAULT must be one of: none, worker, backend, kafka, minio");
  }
  if (config.startWorkerAfterProduce && config.fault !== "none") {
    throw new Error("Backlog preparation cannot inject a runtime fault before the worker starts; use fault=none.");
  }
  if (config.fault !== "none" && config.faultAfter > config.count) {
    throw new Error("ASKLAKE_CONTINUOUS_BASELINE_FAULT_AFTER must not exceed the produced count.");
  }
  return config;
}

function soakEnvironment(config) {
  return {
    ...process.env,
    ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK: "true",
    ASKLAKE_CONTINUOUS_SOAK_INPUT: config.inputPath || "",
    ASKLAKE_CONTINUOUS_SOAK_COUNT: String(config.count),
    ASKLAKE_CONTINUOUS_SOAK_RATE: String(config.rate),
    ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE: String(config.batchSize),
    ASKLAKE_CONTINUOUS_SOAK_PARTITIONS: String(config.partitionCount),
    ASKLAKE_CONTINUOUS_SOAK_TRIGGER_SECONDS: String(config.triggerSeconds),
    ASKLAKE_CONTINUOUS_SOAK_MAX_OFFSETS_PER_TRIGGER: String(config.maxOffsetsPerTrigger),
    ASKLAKE_CONTINUOUS_SOAK_MALFORMED_PERCENT: String(config.malformedPercent),
    ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE: String(config.schemaChange),
    ASKLAKE_CONTINUOUS_SOAK_FAULT: config.fault,
    ASKLAKE_CONTINUOUS_SOAK_FAULT_AFTER: String(config.faultAfter),
    ASKLAKE_CONTINUOUS_SOAK_FAULT_DURATION_MS: String(config.faultDurationMs),
    ASKLAKE_CONTINUOUS_SOAK_START_WORKER_AFTER_PRODUCE: String(config.startWorkerAfterProduce),
    ASKLAKE_CONTINUOUS_SOAK_COMPACT: String(config.compaction),
    ASKLAKE_CONTINUOUS_SOAK_RESOURCE_SAMPLING: String(config.resourceSampling),
  };
}

function parseSoakResult(stdout) {
  const marker = "ASKLAKE_CONTINUOUS_SOAK_RESULT=";
  const line = String(stdout || "").split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) throw new Error("The soak harness completed without ASKLAKE_CONTINUOUS_SOAK_RESULT evidence.");
  try {
    return JSON.parse(line.slice(marker.length));
  } catch (error) {
    throw new Error(`The soak result is not valid JSON: ${error?.message || error}`);
  }
}

function validateMeasurements(value) {
  assert.equal(typeof value, "object");
  for (const field of [
    "producedCount", "producedBytes", "consumedCount", "storedCount", "quarantinedCount", "missingCount", "duplicateCount",
    "peakLag", "finalLag", "peakThroughputRowsPerSecond", "elapsedMs",
  ]) {
    assert(Number.isFinite(value[field]) && value[field] >= 0, `${field} must be a non-negative number`);
  }
  assert.equal(value.consumedCount, value.producedCount, "consumedCount must reconcile with producedCount");
  assert.equal(
    value.storedCount + value.quarantinedCount - Number(value.replayedCount || 0),
    value.producedCount,
    "stored and quarantined counts must reconcile with producedCount",
  );
  assert.equal(value.missingCount, 0, "missingCount must be zero");
  assert.equal(value.duplicateCount, 0, "duplicateCount must be zero");
  assert(value.tuning && Number.isFinite(value.tuning.triggerIntervalSeconds));
  assert(value.tuning && Number.isFinite(value.tuning.maxOffsetsPerTrigger));
  assert(value.resourceUsage && typeof value.resourceUsage === "object");
}

function verifyConfigurationContract() {
  for (const scenario of Object.keys(scenarios)) {
    const config = resolveConfig({ ASKLAKE_CONTINUOUS_BASELINE_SCENARIO: scenario });
    assert.equal(config.scenario, scenario);
    assert(config.count > 0);
    assert(config.rate > 0);
    assert(config.maxOffsetsPerTrigger > 0);
  }
  assert.throws(() => resolveConfig({ ASKLAKE_CONTINUOUS_BASELINE_COUNT: "0" }), /positive integer/);
  assert.throws(() => resolveConfig({ ASKLAKE_CONTINUOUS_BASELINE_SCENARIO: "unknown" }), /must be one of/);
  assert.throws(
    () => resolveConfig({ ASKLAKE_CONTINUOUS_BASELINE_MALFORMED_PERCENT: "101" }),
    /between 0 and 100/,
  );
  assert.throws(
    () => resolveConfig({
      ASKLAKE_CONTINUOUS_BASELINE_SCENARIO: "backlog",
      ASKLAKE_CONTINUOUS_BASELINE_FAULT: "worker",
    }),
    /cannot inject a runtime fault/,
  );
  const measurements = {
    producedCount: 100,
    producedBytes: 10_000,
    consumedCount: 100,
    storedCount: 100,
    quarantinedCount: 0,
    missingCount: 0,
    duplicateCount: 0,
    peakLag: 50,
    finalLag: 0,
    peakThroughputRowsPerSecond: 40,
    elapsedMs: 4_000,
    tuning: { triggerIntervalSeconds: 2, maxOffsetsPerTrigger: 500 },
    resourceUsage: { samples: 2, containers: {} },
  };
  validateMeasurements(measurements);
  assert.throws(() => validateMeasurements({ ...measurements, missingCount: 1 }), /missingCount must be zero/);
  const markdown = renderMarkdown({
    schemaVersion: "asklake.kafka-spark-baseline.v1",
    runId: "contract-check",
    status: "passed",
    startedAt: "2026-07-14T00:00:00.000Z",
    completedAt: "2026-07-14T00:00:04.000Z",
    scenario: resolveConfig({}),
    measurements,
    evaluation: { dataIntegrity: "passed", performanceTarget: "not-set-phase0" },
  });
  assert(markdown.includes("## 측정 결과"));
  assert(markdown.includes("성능 목표 | not-set-phase0"));
  console.log("Kafka Continuous Phase 0 baseline configuration contract verified.");
}

function renderMarkdown(report) {
  const scenario = report.scenario || {};
  const measurements = report.measurements || {};
  const lines = [
    "# Kafka Continuous Phase 0 Baseline",
    "",
    `- Run ID: ${report.runId}`,
    `- 상태: ${report.status}`,
    `- 시작: ${report.startedAt}`,
    `- 종료: ${report.completedAt}`,
    `- 시나리오: ${scenario.scenario || "unknown"}`,
    `- 설명: ${scenario.description || "-"}`,
    "",
    "## 실행 설정",
    "",
    "| 항목 | 값 |",
    "|---|---:|",
    `| 입력 건수 | ${numberOrDash(scenario.count)} |`,
    `| 생산 rate (rows/s) | ${numberOrDash(scenario.rate)} |`,
    `| producer batch | ${numberOrDash(scenario.batchSize)} |`,
    `| topic partitions | ${numberOrDash(scenario.partitionCount)} |`,
    `| trigger (seconds) | ${numberOrDash(scenario.triggerSeconds)} |`,
    `| maxOffsetsPerTrigger | ${numberOrDash(scenario.maxOffsetsPerTrigger)} |`,
    `| fault | ${scenario.fault || "none"} |`,
    `| worker 시작 전 backlog | ${Boolean(scenario.startWorkerAfterProduce)} |`,
    "",
    "## 측정 결과",
    "",
    "| 항목 | 값 |",
    "|---|---:|",
    `| produced | ${numberOrDash(measurements.producedCount)} |`,
    `| produced bytes | ${numberOrDash(measurements.producedBytes)} |`,
    `| average message bytes | ${numberOrDash(measurements.averageMessageBytes)} |`,
    `| consumed | ${numberOrDash(measurements.consumedCount)} |`,
    `| stored | ${numberOrDash(measurements.storedCount)} |`,
    `| quarantined | ${numberOrDash(measurements.quarantinedCount)} |`,
    `| missing | ${numberOrDash(measurements.missingCount)} |`,
    `| duplicate | ${numberOrDash(measurements.duplicateCount)} |`,
    `| peak lag | ${numberOrDash(measurements.peakLag)} |`,
    `| final lag | ${numberOrDash(measurements.finalLag)} |`,
    `| peak throughput (rows/s) | ${numberOrDash(measurements.peakThroughputRowsPerSecond)} |`,
    `| last batch duration (ms) | ${numberOrDash(measurements.lastBatchDurationMs)} |`,
    `| recovery (ms) | ${numberOrDash(measurements.recoveryMs)} |`,
    `| elapsed (ms) | ${numberOrDash(measurements.elapsedMs)} |`,
    "",
    "## 판정",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| 데이터 정합성 | ${report.evaluation?.dataIntegrity || "not-evaluated"} |`,
    `| 성능 목표 | ${report.evaluation?.performanceTarget || "not-set-phase0"} |`,
    `| 비용 조건 | ${report.environment?.costContext || scenario.costContext || "local-unpriced"} |`,
    "",
    "> Phase 0의 측정값은 특정 환경의 근거이며, 승인된 자원·비용 조건 없이 일반적인 TPS 보장으로 사용하지 않는다.",
    "",
  ];
  if (report.environment) {
    lines.push(
      "## 실행 환경",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| Git revision | ${report.sourceRevision || "-"} |`,
      `| Platform | ${report.environment.platform || "-"} / ${report.environment.architecture || "-"} |`,
      `| CPU / memory | ${numberOrDash(report.environment.cpuCount)} / ${numberOrDash(report.environment.totalMemoryBytes)} bytes |`,
      `| Node | ${report.environment.nodeVersion || "-"} |`,
      `| Docker | ${report.environment.dockerVersion || "-"} |`,
      `| Compose | ${report.environment.dockerComposeVersion || "-"} |`,
      "",
    );
  }
  const containers = measurements.resourceUsage?.containers || {};
  if (Object.keys(containers).length) {
    lines.push("## 자원 표본", "", "| Container | Peak CPU | Peak memory bytes | Samples |", "|---|---:|---:|---:|");
    for (const [name, usage] of Object.entries(containers)) {
      lines.push(`| ${escapeTable(name)} | ${numberOrDash(usage.peakCpuPercent)}% | ${numberOrDash(usage.peakMemoryBytes)} | ${numberOrDash(usage.samples)} |`);
    }
    lines.push("");
  }
  if (report.failure) lines.push("## 실패", "", `- ${report.failure}`, "");
  return `${lines.join("\n")}\n`;
}

function environmentEvidence(config) {
  return {
    platform: process.platform,
    architecture: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    dockerVersion: commandVersion("docker", ["--version"]),
    dockerComposeVersion: commandVersion("docker", ["compose", "version"]),
    baseUrl: process.env.ASKLAKE_CONTINUOUS_E2E_BASE_URL || "http://127.0.0.1:8080",
    composeFile: process.env.ASKLAKE_CONTINUOUS_COMPOSE_FILE || "../deploy/docker-compose.prod.yml",
    inputKind: config.inputPath ? "file" : "synthetic",
    costContext: config.costContext,
  };
}

function gitRevision() {
  return commandVersion("git", ["rev-parse", "HEAD"]);
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { cwd: backendDir, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "unavailable";
}

function compactFailure(result) {
  const source = String(result.stderr || result.stdout || `process exited with status ${result.status}`);
  return redactFailure(source.split(/\r?\n/).filter(Boolean).slice(-8).join(" | ")).slice(0, 2_000);
}

function publicScenario(config) {
  return {
    ...config,
    inputPath: config.inputPath ? path.basename(config.inputPath) : null,
  };
}

function redactFailure(value) {
  return String(value || "")
    .replace(/\/Users\/[^/\s|]+/g, "/Users/[USER]")
    .replace(/\/home\/[^/\s|]+/g, "/home/[USER]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s|]+/g, "C:\\Users\\[USER]")
    .replace(/(authorization\s*[:=]\s*)([^\s|]+)/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?key|secret|password|token)\s*[:=]\s*)([^\s|]+)/gi, "$1[REDACTED]");
}

function positiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  if (!/^[1-9]\d*$/.test(String(raw).trim())) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe positive integer.`);
  return value;
}

function percentage(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("ASKLAKE_CONTINUOUS_BASELINE_MALFORMED_PERCENT must be between 0 and 100.");
  }
  return value;
}

function booleanValue(raw, fallback, name) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function optionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function safeRunId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("ASKLAKE_CONTINUOUS_BASELINE_RUN_ID may contain only letters, numbers, dot, underscore, and hyphen.");
  }
  return normalized;
}

function singleLineValue(raw, fallback, name) {
  const value = String(raw || fallback).trim();
  if (!value || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single line with at most 200 characters.`);
  }
  return value;
}

function escapeTable(value) {
  return String(value || "-").replaceAll("|", "\\|");
}

function numberOrDash(value) {
  return Number.isFinite(value) ? String(value) : "-";
}
