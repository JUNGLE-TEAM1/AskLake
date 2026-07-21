#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  sparkResourcePlannerRuntimeConfigHash,
} from "./build-eks-spark-resource-planner-shadow-web-values.mjs";


function fail(message) {
  throw new Error(message);
}


export function buildSparkResourcePlannerEnforceWebValues(baseWebValues, runtimeValues) {
  if (
    !baseWebValues?.backend
    || typeof baseWebValues.backend !== "object"
    || Array.isArray(baseWebValues.backend)
  ) {
    fail("base asklake-web values do not contain backend settings");
  }
  const data = runtimeValues?.configMap?.data;
  if (
    runtimeValues?.namespace !== "asklake-dev"
    || runtimeValues?.configMap?.name !== "asklake-runtime"
    || data?.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE !== "enforce"
    || data?.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES !== "1"
  ) {
    fail("runtime values are not the asklake-dev Resource Planner enforce candidate");
  }
  const runtimeConfigDataHash = sparkResourcePlannerRuntimeConfigHash(runtimeValues);
  const runtimeConfigRevision = `sprp-enforce-${runtimeConfigDataHash.slice(0, 16)}`;
  const candidate = structuredClone(baseWebValues);
  candidate.backend.runtimeConfigRevision = runtimeConfigRevision;
  return { candidate, runtimeConfigDataHash, runtimeConfigRevision };
}


function main() {
  const baseWebValuesPath = process.argv[2];
  const runtimeValuesPath = process.argv[3];
  if (!baseWebValuesPath || !runtimeValuesPath || process.argv.length !== 4) {
    console.error(`usage: ${process.argv[1]} <base-web-values.json> <enforce-runtime-values.json>`);
    process.exit(2);
  }
  try {
    const baseWebValues = JSON.parse(readFileSync(baseWebValuesPath, "utf8"));
    const runtimeValues = JSON.parse(readFileSync(runtimeValuesPath, "utf8"));
    const { candidate } = buildSparkResourcePlannerEnforceWebValues(baseWebValues, runtimeValues);
    process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
