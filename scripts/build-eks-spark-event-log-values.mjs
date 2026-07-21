#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EVENT_LOG_CONFIG = Object.freeze({
  ASKLAKE_SPARK_EVENT_LOG_PREFIX: "spark-events",
});

function fail(message) {
  throw new Error(message);
}

function runtimeData(base) {
  if (
    !base
    || typeof base !== "object"
    || Array.isArray(base)
    || base.namespace !== "asklake-dev"
    || base.configMap?.name !== "asklake-runtime"
    || !base.configMap?.data
    || typeof base.configMap.data !== "object"
    || Array.isArray(base.configMap.data)
  ) {
    fail("base runtime values do not match the asklake-dev/asklake-runtime contract");
  }
  return base.configMap.data;
}

export function buildSparkEventLogValues(base, target) {
  if (!new Set(["disable", "enable"]).has(target)) {
    fail("Spark event log target must be enable or disable");
  }
  const data = runtimeData(base);
  if (String(data.ASKLAKE_OBJECT_STORAGE_PROVIDER || "") !== "aws") {
    fail("Spark event logging requires the AWS object storage runtime");
  }
  if (!String(data.ASKLAKE_SPARK_OUTPUT_BUCKET || "").trim()) {
    fail("Spark event logging requires the existing output bucket");
  }
  if (!String(data.ASKLAKE_SPARK_OUTPUT_PREFIX || "").trim()) {
    fail("Spark event logging requires the existing output prefix");
  }
  if (target === "enable") {
    if (String(data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE || "off") !== "off") {
      fail("the bounded Phase 7 smoke requires the Spark Resource Planner off");
    }
    if (String(data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES || "") !== "1") {
      fail("the bounded Phase 7 smoke requires executor baseline 1");
    }
  }

  const candidate = structuredClone(base);
  Object.assign(candidate.configMap.data, EVENT_LOG_CONFIG, {
    ASKLAKE_SPARK_EVENT_LOG_ENABLED: target === "enable" ? "true" : "false",
  });
  return candidate;
}

function main() {
  const input = process.argv[2];
  const target = process.argv[3];
  if (!input || !target || process.argv.length !== 4) {
    console.error(`usage: ${process.argv[1]} <base-runtime-values.json> <enable|disable>`);
    process.exit(2);
  }
  try {
    const base = JSON.parse(readFileSync(input, "utf8"));
    process.stdout.write(`${JSON.stringify(buildSparkEventLogValues(base, target), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
