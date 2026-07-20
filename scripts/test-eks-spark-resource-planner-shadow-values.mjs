#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSparkResourcePlannerShadowValues,
} from "./build-eks-spark-resource-planner-shadow-values.mjs";


function baseValues(overrides = {}) {
  return {
    namespace: "asklake-dev",
    configMap: {
      name: "asklake-runtime",
      data: {
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "2",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY: "4g",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD: "1g",
        ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off",
        PRESERVED_RUNTIME_KEY: "unchanged",
        ...overrides,
      },
    },
  };
}


test("builds a shadow candidate with only the fixed V1 policy delta", () => {
  const base = baseValues();
  const candidate = buildSparkResourcePlannerShadowValues(base);

  assert.equal(base.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "off");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "shadow");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES, "134217728");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR, "384");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS, "1");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS, "4");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES, "1");
  assert.equal(candidate.configMap.data.PRESERVED_RUNTIME_KEY, "unchanged");
});

test("rejects a nonstandard executor profile or non-one baseline", () => {
  assert.throws(
    () => buildSparkResourcePlannerShadowValues(baseValues({
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "2",
    })),
    /CORE_LIMIT=3/,
  );
  assert.throws(
    () => buildSparkResourcePlannerShadowValues(baseValues({
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "2",
    })),
    /baseline to be 1/,
  );
});

test("rejects preparation from an already active planner mode", () => {
  for (const mode of ["shadow", "enforce"]) {
    assert.throws(
      () => buildSparkResourcePlannerShadowValues(baseValues({
        ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: mode,
      })),
      /must have the Spark Resource Planner off/,
    );
  }
});

test("rejects a runtime values object outside the dedicated ConfigMap contract", () => {
  assert.throws(
    () => buildSparkResourcePlannerShadowValues({
      namespace: "other",
      configMap: { name: "asklake-runtime", data: {} },
    }),
    /contract/,
  );
});
