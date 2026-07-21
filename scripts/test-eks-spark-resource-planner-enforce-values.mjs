#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSparkResourcePlannerEnforceValues,
} from "./build-eks-spark-resource-planner-enforce-values.mjs";
import {
  buildSparkResourcePlannerEnforceWebValues,
} from "./build-eks-spark-resource-planner-enforce-web-values.mjs";


function shadowValues(overrides = {}) {
  return {
    namespace: "asklake-dev",
    configMap: {
      name: "asklake-runtime",
      data: {
        ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow",
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
        PRESERVED: "yes",
        ...overrides,
      },
    },
  };
}


test("promotes shadow to enforce by changing only the planner mode", () => {
  const base = shadowValues();
  const candidate = buildSparkResourcePlannerEnforceValues(base);
  assert.equal(base.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "shadow");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "enforce");
  assert.deepEqual(
    { ...candidate.configMap.data, ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow" },
    base.configMap.data,
  );
});


test("rejects promotion without shadow and the exact bounded profile", () => {
  for (const values of [
    shadowValues({ ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off" }),
    shadowValues({ ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "2" }),
    shadowValues({ ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "6" }),
  ]) {
    assert.throws(() => buildSparkResourcePlannerEnforceValues(values), /requires|shadow/);
  }
});


test("changes only Web runtimeConfigRevision for enforce", () => {
  const runtime = buildSparkResourcePlannerEnforceValues(shadowValues());
  const baseWeb = { backend: { image: "backend", runtimeConfigRevision: "shadow" }, enabled: true };
  const result = buildSparkResourcePlannerEnforceWebValues(baseWeb, runtime);
  assert.match(result.runtimeConfigRevision, /^sprp-enforce-[0-9a-f]{16}$/);
  assert.deepEqual(
    { ...result.candidate, backend: { ...result.candidate.backend, runtimeConfigRevision: "shadow" } },
    baseWeb,
  );
});
