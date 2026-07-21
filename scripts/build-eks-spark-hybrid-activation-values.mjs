#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


export const DIRECT_CACHE_MAX_SOURCE_BYTES = "10737418240";


function fail(message) {
  throw new Error(message);
}


function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}


function requireImmutableImage(value, component) {
  const image = String(value || "");
  if (!new RegExp(`/asklake/dev/${component}@sha256:[a-f0-9]{64}$`).test(image)) {
    fail(`${component} image must be an immutable dev ECR reference`);
  }
  return image;
}


export function runtimeConfigDataHash(runtimeValues) {
  const data = requireObject(runtimeValues?.configMap?.data, "runtime ConfigMap data");
  const canonical = Object.fromEntries(
    Object.entries(data).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}


export function buildSparkHybridActivationValues(
  baseRuntimeValues,
  baseWebValues,
  imageReceipt,
) {
  requireObject(baseRuntimeValues, "base runtime values");
  requireObject(baseWebValues, "base Web values");
  requireObject(imageReceipt, "image receipt");
  if (
    baseRuntimeValues.namespace !== "asklake-dev"
    || baseRuntimeValues.configMap?.name !== "asklake-runtime"
  ) {
    fail("base runtime values must target asklake-dev/asklake-runtime");
  }
  requireObject(baseRuntimeValues.configMap.data, "base runtime ConfigMap data");
  requireObject(baseWebValues.backend, "base Web backend values");
  if (!/^[a-f0-9]{40}$/.test(String(imageReceipt.gitRevision || ""))) {
    fail("image receipt gitRevision must be a full Git SHA");
  }

  const backendImage = requireImmutableImage(imageReceipt.images?.backend, "backend");
  const sparkImage = requireImmutableImage(imageReceipt.images?.sparkRuntime, "spark-runtime");
  const runtimeValues = structuredClone(baseRuntimeValues);
  runtimeValues.configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES =
    DIRECT_CACHE_MAX_SOURCE_BYTES;
  runtimeValues.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE = sparkImage;

  const runtimeDataHash = runtimeConfigDataHash(runtimeValues);
  const runtimeConfigRevision = `spark-hybrid-${runtimeDataHash.slice(0, 16)}`;
  const webValues = structuredClone(baseWebValues);
  webValues.backend.image = backendImage;
  webValues.backend.runtimeConfigRevision = runtimeConfigRevision;

  return {
    runtimeConfigRevision,
    runtimeDataHash,
    runtimeValues,
    webValues,
  };
}


function main() {
  if (process.argv.length !== 5) {
    console.error(
      `usage: ${process.argv[1]} <base-runtime-values.json> <base-web-values.json> <image-receipt.json>`,
    );
    process.exit(2);
  }
  try {
    const [baseRuntimePath, baseWebPath, receiptPath] = process.argv.slice(2);
    const result = buildSparkHybridActivationValues(
      JSON.parse(readFileSync(baseRuntimePath, "utf8")),
      JSON.parse(readFileSync(baseWebPath, "utf8")),
      JSON.parse(readFileSync(receiptPath, "utf8")),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
