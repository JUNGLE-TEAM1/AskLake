#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSparkEventLogLines } from "./summarize-spark-event-log.mjs";

test("Spark event log summary aggregates task, executor, shuffle, spill, and peak memory evidence", () => {
  const lines = [
    { Event: "SparkListenerApplicationStart", Timestamp: 1_000 },
    { Event: "SparkListenerExecutorAdded", "Executor ID": "driver" },
    { Event: "SparkListenerExecutorAdded", "Executor ID": "1" },
    { Event: "SparkListenerExecutorAdded", "Executor ID": "2" },
    { Event: "SparkListenerJobStart", "Stage IDs": [3] },
    {
      Event: "SparkListenerTaskEnd",
      "Stage ID": 3,
      "Task End Reason": { Reason: "Success" },
      "Task Metrics": {
        "Executor Run Time": 1_000,
        "Executor CPU Time": 750_000_000,
        "JVM GC Time": 25,
        "Input Metrics": { "Bytes Read": 100, "Records Read": 10 },
        "Output Metrics": { "Bytes Written": 80, "Records Written": 8 },
        "Shuffle Read Metrics": {
          "Remote Bytes Read": 20,
          "Local Bytes Read": 30,
          "Total Records Read": 5,
        },
        "Shuffle Write Metrics": { "Shuffle Bytes Written": 40, "Shuffle Records Written": 4 },
        "Memory Bytes Spilled": 7,
        "Disk Bytes Spilled": 9,
      },
      "Task Executor Metrics": { JVMHeapMemory: 500, ProcessTreeJVMRSSMemory: 700 },
    },
    {
      Event: "SparkListenerTaskEnd",
      "Stage ID": 4,
      "Task End Reason": { Reason: "ExceptionFailure" },
      "Task Metrics": {
        "Executor Run Time": 500,
        "Executor CPU Time": 250_000_000,
        "Memory Bytes Spilled": 3,
        "Disk Bytes Spilled": 1,
      },
      "Task Executor Metrics": { JVMHeapMemory: 800, ProcessTreeJVMRSSMemory: 600 },
    },
    { Event: "SparkListenerExecutorRemoved", "Executor ID": "1" },
    { Event: "SparkListenerJobEnd" },
    { Event: "SparkListenerApplicationEnd", Timestamp: 11_000 },
    "not-json",
  ].map((item) => typeof item === "string" ? item : JSON.stringify(item));

  const summary = summarizeSparkEventLogLines(lines);
  assert.equal(summary.eventCount, 10);
  assert.equal(summary.invalidLineCount, 1);
  assert.deepEqual(summary.application, { startedAtMs: 1_000, endedAtMs: 11_000, durationMs: 10_000 });
  assert.deepEqual(summary.jobs, { started: 1, ended: 1 });
  assert.equal(summary.stages.unique, 2);
  assert.deepEqual(summary.executors, { added: 2, removed: 1, peakActive: 2 });
  assert.deepEqual(summary.tasks, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(summary.taskMetrics.executorRunTimeMs, 1_500);
  assert.equal(summary.taskMetrics.executorCpuTimeNs, 1_000_000_000);
  assert.equal(summary.taskMetrics.taskCpuUtilizationRatio, 0.666667);
  assert.equal(summary.taskMetrics.shuffleReadBytes, 50);
  assert.equal(summary.taskMetrics.shuffleWriteBytes, 40);
  assert.equal(summary.taskMetrics.memoryBytesSpilled, 10);
  assert.equal(summary.taskMetrics.diskBytesSpilled, 10);
  assert.equal(summary.peakExecutorMetrics.JVMHeapMemory, 800);
  assert.equal(summary.peakExecutorMetrics.ProcessTreeJVMRSSMemory, 700);
  assert.doesNotMatch(JSON.stringify(summary), /Executor ID|runId|jobId/);
});

test("empty event log remains explicit instead of fabricating zero utilization", () => {
  const summary = summarizeSparkEventLogLines([]);
  assert.equal(summary.eventCount, 0);
  assert.equal(summary.application.durationMs, null);
  assert.equal(summary.taskMetrics.taskCpuUtilizationRatio, null);
});
