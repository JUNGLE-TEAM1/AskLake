#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


function fail(message) {
  throw new Error(message);
}


export function sparkResourcePlannerRuntimeConfigHash(runtimeValues) {
  const data = runtimeValues?.configMap?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("runtime ConfigMap candidate data is missing");
  }
  const canonical = Object.fromEntries(
    Object.entries(data).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}


export function buildSparkResourcePlannerShadowWebValues(baseWebValues, runtimeValues) {
  if (
    !baseWebValues
    || typeof baseWebValues !== "object"
    || Array.isArray(baseWebValues)
    || !baseWebValues.backend
    || typeof baseWebValues.backend !== "object"
    || Array.isArray(baseWebValues.backend)
  ) {
    fail("base asklake-web values do not contain backend settings");
  }
  if (
    runtimeValues?.namespace !== "asklake-dev"
    || runtimeValues?.configMap?.name !== "asklake-runtime"
    || runtimeValues?.configMap?.data?.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE !== "shadow"
  ) {
    fail("runtime values are not the asklake-dev Resource Planner shadow candidate");
  }
  const runtimeConfigDataHash = sparkResourcePlannerRuntimeConfigHash(runtimeValues);
  const runtimeConfigRevision = `sprp-shadow-${runtimeConfigDataHash.slice(0, 16)}`;
  const candidate = structuredClone(baseWebValues);
  candidate.backend.runtimeConfigRevision = runtimeConfigRevision;
  return { candidate, runtimeConfigDataHash, runtimeConfigRevision };
}


function main() {
  const baseWebValuesPath = process.argv[2];
  const runtimeValuesPath = process.argv[3];
  if (!baseWebValuesPath || !runtimeValuesPath || process.argv.length !== 4) {
    console.error(`usage: ${process.argv[1]} <base-web-values.json> <shadow-runtime-values.json>`);
    process.exit(2);
  }
  try {
    const baseWebValues = JSON.parse(readFileSync(baseWebValuesPath, "utf8"));
    const runtimeValues = JSON.parse(readFileSync(runtimeValuesPath, "utf8"));
    const { candidate } = buildSparkResourcePlannerShadowWebValues(baseWebValues, runtimeValues);
    process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
