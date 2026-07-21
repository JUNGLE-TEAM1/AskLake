#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


const OFF_ALIGNMENT = Object.freeze({
  ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off",
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
  ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
  ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY: "4g",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD: "1g",
});

const REQUIRED_EXISTING_PROFILE = Object.freeze({
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY: "4g",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD: "1g",
});

const OPTIONAL_EXISTING_VALUES = Object.freeze({
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
  ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
  ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
  ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
  ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
});

const IMMUTABLE_SPARK_IMAGE = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/(?:[a-z0-9][a-z0-9._/-]*\/)?asklake\/(?:dev|staging)\/spark-runtime@sha256:[a-f0-9]{64}$/;


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


export function buildSparkResourcePlannerOffValues(base, sparkImage) {
  const data = runtimeData(base);
  if (!IMMUTABLE_SPARK_IMAGE.test(String(sparkImage || ""))) {
    fail("formal receipt Spark image must be an immutable dev/staging ECR digest");
  }
  for (const [name, expected] of Object.entries(REQUIRED_EXISTING_PROFILE)) {
    if (String(data[name] || "") !== expected) {
      fail(`off alignment requires existing ${name}=${expected}`);
    }
  }
  const currentMode = String(data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE || "off");
  if (!["off", "shadow", "enforce"].includes(currentMode)) {
    fail("off alignment refuses to overwrite an invalid Planner mode");
  }
  if (currentMode === "shadow" || currentMode === "enforce") {
    for (const [name, expected] of Object.entries(OFF_ALIGNMENT)) {
      if (name !== "ASKLAKE_SPARK_RESOURCE_PLANNER_MODE" && String(data[name] || "") !== expected) {
        fail(`active Planner recovery requires existing ${name}=${expected}`);
      }
    }
    if (String(data.ASKLAKE_SPARK_KUBERNETES_IMAGE || "") !== sparkImage) {
      fail("active Planner recovery refuses to change the Spark image");
    }
  } else {
    for (const [name, expected] of Object.entries(OPTIONAL_EXISTING_VALUES)) {
      const current = String(data[name] || "");
      if (current && current !== expected) {
        fail(`off alignment refuses to overwrite unexpected ${name}`);
      }
    }
  }
  const candidate = structuredClone(base);
  Object.assign(candidate.configMap.data, OFF_ALIGNMENT, {
    ASKLAKE_SPARK_KUBERNETES_IMAGE: sparkImage,
  });
  return candidate;
}


function main() {
  const basePath = process.argv[2];
  const receiptPath = process.argv[3];
  if (!basePath || !receiptPath || process.argv.length !== 4) {
    console.error(`usage: ${process.argv[1]} <base-runtime-values.json> <image-receipt.json>`);
    process.exit(2);
  }
  try {
    const base = JSON.parse(readFileSync(basePath, "utf8"));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const candidate = buildSparkResourcePlannerOffValues(base, receipt?.images?.sparkRuntime);
    process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
