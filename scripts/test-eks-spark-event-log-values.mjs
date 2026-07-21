#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { buildSparkEventLogValues } from "./build-eks-spark-event-log-values.mjs";

function baseValues(overrides = {}) {
  return {
    namespace: "asklake-dev",
    configMap: {
      name: "asklake-runtime",
      data: {
        ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
        ASKLAKE_SPARK_OUTPUT_BUCKET: "asklake-dev-output-example",
        ASKLAKE_SPARK_OUTPUT_PREFIX: "asklake-output",
        ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off",
        PRESERVED_RUNTIME_KEY: "unchanged",
        ...overrides,
      },
    },
  };
}

test("event log candidate changes only the bounded opt-in keys", () => {
  const base = baseValues();
  const enabled = buildSparkEventLogValues(base, "enable");
  assert.equal(base.configMap.data.ASKLAKE_SPARK_EVENT_LOG_ENABLED, undefined);
  assert.equal(enabled.configMap.data.ASKLAKE_SPARK_EVENT_LOG_ENABLED, "true");
  assert.equal(enabled.configMap.data.ASKLAKE_SPARK_EVENT_LOG_PREFIX, "spark-events");
  assert.equal(enabled.configMap.data.PRESERVED_RUNTIME_KEY, "unchanged");

  const disabled = buildSparkEventLogValues(enabled, "disable");
  assert.equal(disabled.configMap.data.ASKLAKE_SPARK_EVENT_LOG_ENABLED, "false");
  assert.equal(disabled.configMap.data.ASKLAKE_SPARK_EVENT_LOG_PREFIX, "spark-events");
});

test("event log enable refuses an active Planner or non-one executor baseline", () => {
  assert.throws(
    () => buildSparkEventLogValues(baseValues({ ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow" }), "enable"),
    /Planner off/,
  );
  assert.throws(
    () => buildSparkEventLogValues(baseValues({ ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "2" }), "enable"),
    /baseline 1/,
  );
});

test("event log enable requires the existing AWS output boundary", () => {
  assert.throws(
    () => buildSparkEventLogValues(baseValues({ ASKLAKE_OBJECT_STORAGE_PROVIDER: "minio" }), "enable"),
    /AWS object storage/,
  );
  assert.throws(
    () => buildSparkEventLogValues(baseValues({ ASKLAKE_SPARK_OUTPUT_BUCKET: "" }), "enable"),
    /output bucket/,
  );
  assert.throws(
    () => buildSparkEventLogValues(baseValues(), "other"),
    /enable or disable/,
  );
});
