#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSparkResourcePlannerShadowWebValues,
} from "./build-eks-spark-resource-planner-shadow-web-values.mjs";


function runtimeValues(dataOverrides = {}) {
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
        ...dataOverrides,
      },
    },
  };
}


test("changes only runtimeConfigRevision using the runtime data hash", () => {
  const base = {
    enabled: true,
    backend: { image: "example.invalid/backend", runtimeConfigRevision: "prior" },
    frontend: { image: "example.invalid/frontend" },
  };
  const result = buildSparkResourcePlannerShadowWebValues(base, runtimeValues());

  assert.match(result.runtimeConfigDataHash, /^[0-9a-f]{64}$/);
  assert.equal(
    result.runtimeConfigRevision,
    `sprp-shadow-${result.runtimeConfigDataHash.slice(0, 16)}`,
  );
  assert.equal(base.backend.runtimeConfigRevision, "prior");
  assert.deepEqual(
    { ...result.candidate, backend: { ...result.candidate.backend, runtimeConfigRevision: "prior" } },
    base,
  );
});

test("runtime revision is stable across ConfigMap key order", () => {
  const base = { backend: {} };
  const left = runtimeValues({ A_KEY: "a", Z_KEY: "z" });
  const right = runtimeValues({ Z_KEY: "z", A_KEY: "a" });

  assert.equal(
    buildSparkResourcePlannerShadowWebValues(base, left).runtimeConfigRevision,
    buildSparkResourcePlannerShadowWebValues(base, right).runtimeConfigRevision,
  );
});

test("rejects a non-shadow runtime candidate or malformed Web values", () => {
  assert.throws(
    () => buildSparkResourcePlannerShadowWebValues(
      { backend: {} },
      runtimeValues({ ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "enforce" }),
    ),
    /not the asklake-dev Resource Planner shadow candidate/,
  );
  assert.throws(
    () => buildSparkResourcePlannerShadowWebValues({}, runtimeValues()),
    /do not contain backend settings/,
  );
});
