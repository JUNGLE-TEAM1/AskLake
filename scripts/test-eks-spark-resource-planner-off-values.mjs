#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSparkResourcePlannerOffValues,
} from "./build-eks-spark-resource-planner-off-values.mjs";
import {
  buildSparkResourcePlannerOffWebValues,
} from "./build-eks-spark-resource-planner-off-web-values.mjs";


const OLD_SPARK_IMAGE = `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/dev/spark-runtime@sha256:${"a".repeat(64)}`;
const NEW_SPARK_IMAGE = `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/dev/spark-runtime@sha256:${"b".repeat(64)}`;


function baseValues(dataOverrides = {}) {
  return {
    namespace: "asklake-dev",
    configMap: {
      name: "asklake-runtime",
      data: {
        EXISTING_UNRELATED_KEY: "preserved",
        ASKLAKE_SPARK_KUBERNETES_IMAGE: OLD_SPARK_IMAGE,
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "1",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "2",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY: "4g",
        ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD: "1g",
        ...dataOverrides,
      },
    },
  };
}


test("builds an off candidate that aligns only the approved image, policy, and profile", () => {
  const base = baseValues();
  const candidate = buildSparkResourcePlannerOffValues(base, NEW_SPARK_IMAGE);

  assert.equal(base.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT, undefined);
  assert.equal(candidate.configMap.data.EXISTING_UNRELATED_KEY, "preserved");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE, NEW_SPARK_IMAGE);
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "off");
  assert.equal(
    candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR,
    "384",
  );
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS, "4");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST, "2");
  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT, "3");
});


test("accepts an already explicit off standard-v1 base", () => {
  const candidate = buildSparkResourcePlannerOffValues(
    baseValues({
      ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "off",
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
      ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
      ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
    }),
    NEW_SPARK_IMAGE,
  );

  assert.equal(candidate.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "off");
});


test("recovers an exact active Planner profile by changing only the mode", () => {
  for (const mode of ["shadow", "enforce"]) {
    const base = baseValues({
      ASKLAKE_SPARK_KUBERNETES_IMAGE: NEW_SPARK_IMAGE,
      ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: mode,
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
      ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
      ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
    });
    const candidate = buildSparkResourcePlannerOffValues(base, NEW_SPARK_IMAGE);
    assert.deepEqual(
      { ...candidate.configMap.data, ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: mode },
      base.configMap.data,
    );
  }
});


test("rejects incomplete active recovery, baseline/profile drift, and unexpected policy drift", () => {
  const cases = [
    baseValues({ ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow" }),
    baseValues({
      ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "enforce",
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES: "134217728",
      ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "384",
      ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS: "1",
      ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS: "4",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST: "2",
      ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "3",
    }),
    baseValues({ ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES: "2" }),
    baseValues({ ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES: "3" }),
    baseValues({ ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT: "4" }),
    baseValues({ ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR: "96" }),
  ];
  for (const values of cases) {
    assert.throws(
      () => buildSparkResourcePlannerOffValues(values, NEW_SPARK_IMAGE),
      /off alignment|active Planner recovery/,
    );
  }
});


test("rejects a mutable or non-Spark receipt image", () => {
  assert.throws(
    () => buildSparkResourcePlannerOffValues(baseValues(), "example.invalid/spark:latest"),
    /immutable dev\/staging ECR digest/,
  );
});


test("changes only Web runtimeConfigRevision for the off candidate", () => {
  const runtime = buildSparkResourcePlannerOffValues(baseValues(), NEW_SPARK_IMAGE);
  const baseWeb = {
    enabled: true,
    backend: { image: "example.invalid/backend", runtimeConfigRevision: "prior" },
    frontend: { image: "example.invalid/frontend" },
  };
  const result = buildSparkResourcePlannerOffWebValues(baseWeb, runtime);

  assert.match(result.runtimeConfigRevision, /^sprp-off-[0-9a-f]{16}$/);
  assert.equal(baseWeb.backend.runtimeConfigRevision, "prior");
  assert.deepEqual(
    { ...result.candidate, backend: { ...result.candidate.backend, runtimeConfigRevision: "prior" } },
    baseWeb,
  );
});


test("rejects a shadow or incomplete off Web runtime candidate", () => {
  const runtime = buildSparkResourcePlannerOffValues(baseValues(), NEW_SPARK_IMAGE);
  assert.throws(
    () => buildSparkResourcePlannerOffWebValues(
      { backend: {} },
      {
        ...runtime,
        configMap: {
          ...runtime.configMap,
          data: {
            ...runtime.configMap.data,
            ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow",
          },
        },
      },
    ),
    /off alignment candidate/,
  );
  assert.throws(
    () => buildSparkResourcePlannerOffWebValues({}, runtime),
    /do not contain backend settings/,
  );
});
