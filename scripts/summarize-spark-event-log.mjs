#!/usr/bin/env node

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const EXECUTOR_METRIC_KEYS = new Set([
  "JVMHeapMemory",
  "JVMOffHeapMemory",
  "OnHeapExecutionMemory",
  "OffHeapExecutionMemory",
  "OnHeapStorageMemory",
  "OffHeapStorageMemory",
  "OnHeapUnifiedMemory",
  "OffHeapUnifiedMemory",
  "DirectPoolMemory",
  "MappedPoolMemory",
  "ProcessTreeJVMVMemory",
  "ProcessTreeJVMRSSMemory",
  "ProcessTreePythonVMemory",
  "ProcessTreePythonRSSMemory",
  "ProcessTreeOtherVMemory",
  "ProcessTreeOtherRSSMemory",
  "MinorGCCount",
  "MinorGCTime",
  "MajorGCCount",
  "MajorGCTime",
  "TotalGCTime",
  "ConcurrentGCCount",
  "ConcurrentGCTime",
]);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nestedMetric(metrics, section, key) {
  return number(metrics?.[section]?.[key]);
}

function successfulTask(reason) {
  if (reason === "Success") return true;
  return reason?.Reason === "Success" || reason?.reason === "Success";
}

function mergePeakExecutorMetrics(target, value, depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) mergePeakExecutorMetrics(target, item, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, metric] of Object.entries(value)) {
    if (EXECUTOR_METRIC_KEYS.has(key)) {
      target[key] = Math.max(target[key] || 0, number(metric));
    } else if (typeof metric === "object" && metric !== null) {
      mergePeakExecutorMetrics(target, metric, depth + 1);
    }
  }
}

export function summarizeSparkEventLogLines(lines) {
  const summary = {
    contractVersion: "1.0",
    source: "spark_event_log",
    eventCount: 0,
    invalidLineCount: 0,
    application: { startedAtMs: null, endedAtMs: null, durationMs: null },
    jobs: { started: 0, ended: 0 },
    stages: { unique: 0 },
    executors: { added: 0, removed: 0, peakActive: 0 },
    tasks: { total: 0, succeeded: 0, failed: 0 },
    taskMetrics: {
      executorRunTimeMs: 0,
      executorCpuTimeNs: 0,
      taskCpuUtilizationRatio: null,
      jvmGcTimeMs: 0,
      inputBytes: 0,
      inputRecords: 0,
      outputBytes: 0,
      outputRecords: 0,
      shuffleReadBytes: 0,
      shuffleReadRecords: 0,
      shuffleWriteBytes: 0,
      shuffleWriteRecords: 0,
      memoryBytesSpilled: 0,
      diskBytesSpilled: 0,
    },
    peakExecutorMetrics: {},
  };
  const stages = new Set();
  const activeExecutors = new Set();

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.invalidLineCount += 1;
      continue;
    }
    summary.eventCount += 1;
    const type = event.Event;

    if (type === "SparkListenerApplicationStart") {
      summary.application.startedAtMs = number(event.Timestamp);
    } else if (type === "SparkListenerApplicationEnd") {
      summary.application.endedAtMs = number(event.Timestamp);
    } else if (type === "SparkListenerJobStart") {
      summary.jobs.started += 1;
      for (const stageId of event["Stage IDs"] || []) stages.add(String(stageId));
    } else if (type === "SparkListenerJobEnd") {
      summary.jobs.ended += 1;
    } else if (type === "SparkListenerStageSubmitted" || type === "SparkListenerStageCompleted") {
      const stageId = event["Stage Info"]?.["Stage ID"];
      if (stageId != null) stages.add(String(stageId));
    } else if (type === "SparkListenerExecutorAdded") {
      const executorId = String(event["Executor ID"] || "");
      if (executorId && executorId !== "driver") {
        summary.executors.added += 1;
        activeExecutors.add(executorId);
        summary.executors.peakActive = Math.max(summary.executors.peakActive, activeExecutors.size);
      }
    } else if (type === "SparkListenerExecutorRemoved") {
      const executorId = String(event["Executor ID"] || "");
      if (executorId && executorId !== "driver") {
        summary.executors.removed += 1;
        activeExecutors.delete(executorId);
      }
    } else if (type === "SparkListenerTaskEnd") {
      summary.tasks.total += 1;
      const reason = event["Task End Reason"];
      if (successfulTask(reason)) summary.tasks.succeeded += 1;
      else summary.tasks.failed += 1;
      if (event["Stage ID"] != null) stages.add(String(event["Stage ID"]));

      const metrics = event["Task Metrics"] || {};
      summary.taskMetrics.executorRunTimeMs += number(metrics["Executor Run Time"]);
      summary.taskMetrics.executorCpuTimeNs += number(metrics["Executor CPU Time"]);
      summary.taskMetrics.jvmGcTimeMs += number(metrics["JVM GC Time"]);
      summary.taskMetrics.inputBytes += nestedMetric(metrics, "Input Metrics", "Bytes Read");
      summary.taskMetrics.inputRecords += nestedMetric(metrics, "Input Metrics", "Records Read");
      summary.taskMetrics.outputBytes += nestedMetric(metrics, "Output Metrics", "Bytes Written");
      summary.taskMetrics.outputRecords += nestedMetric(metrics, "Output Metrics", "Records Written");
      summary.taskMetrics.shuffleReadBytes +=
        nestedMetric(metrics, "Shuffle Read Metrics", "Remote Bytes Read") +
        nestedMetric(metrics, "Shuffle Read Metrics", "Local Bytes Read");
      summary.taskMetrics.shuffleReadRecords += nestedMetric(metrics, "Shuffle Read Metrics", "Total Records Read");
      summary.taskMetrics.shuffleWriteBytes += nestedMetric(metrics, "Shuffle Write Metrics", "Shuffle Bytes Written");
      summary.taskMetrics.shuffleWriteRecords += nestedMetric(metrics, "Shuffle Write Metrics", "Shuffle Records Written");
      summary.taskMetrics.memoryBytesSpilled += number(metrics["Memory Bytes Spilled"]);
      summary.taskMetrics.diskBytesSpilled += number(metrics["Disk Bytes Spilled"]);
    }

    mergePeakExecutorMetrics(summary.peakExecutorMetrics, event);
  }

  summary.stages.unique = stages.size;
  if (summary.application.startedAtMs != null && summary.application.endedAtMs != null) {
    summary.application.durationMs = Math.max(
      0,
      summary.application.endedAtMs - summary.application.startedAtMs,
    );
  }
  if (summary.taskMetrics.executorRunTimeMs > 0) {
    summary.taskMetrics.taskCpuUtilizationRatio = Number((
      summary.taskMetrics.executorCpuTimeNs /
      (summary.taskMetrics.executorRunTimeMs * 1_000_000)
    ).toFixed(6));
  }
  return summary;
}

export async function summarizeSparkEventLogFile(inputPath) {
  const lines = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const collected = [];
  for await (const line of lines) collected.push(line);
  return summarizeSparkEventLogLines(collected);
}

async function main(argv) {
  const [inputPath, outputPath] = argv;
  if (!inputPath || argv.length > 2) {
    throw new Error("Usage: node scripts/summarize-spark-event-log.mjs <event-log> [private-output.json]");
  }
  const summary = await summarizeSparkEventLogFile(inputPath);
  const payload = `${JSON.stringify(summary, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, payload, { encoding: "utf8", mode: 0o600 });
  } else {
    process.stdout.write(payload);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
