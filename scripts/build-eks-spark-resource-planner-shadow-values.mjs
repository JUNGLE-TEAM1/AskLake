#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


const SHADOW_POLICY = Object.freeze({
  ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow",
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
  ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
  ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
});

const STANDARD_EXECUTOR_PROFILE = Object.freeze({
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY: "4g",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD: "1g",
});


function fail(message) {
  throw new Error(message);
}


export function buildSparkResourcePlannerShadowValues(base) {
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
  const data = base.configMap.data;
  const currentMode = String(data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE || "off");
  if (currentMode !== "off") {
    fail("base runtime values must have the Spark Resource Planner off");
  }
  if (String(data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES || "") !== "1") {
    fail("Phase 3 shadow requires the existing executor baseline to be 1");
  }
  for (const [name, expected] of Object.entries(STANDARD_EXECUTOR_PROFILE)) {
    if (String(data[name] || "") !== expected) {
      fail(`Phase 3 shadow requires ${name}=${expected}`);
    }
  }
  const candidate = structuredClone(base);
  Object.assign(candidate.configMap.data, SHADOW_POLICY);
  return candidate;
}


function main() {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) {
    console.error(`usage: ${process.argv[1]} <base-runtime-values.json>`);
    process.exit(2);
  }
  try {
    const base = JSON.parse(readFileSync(input, "utf8"));
    process.stdout.write(`${JSON.stringify(buildSparkResourcePlannerShadowValues(base), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
