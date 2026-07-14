import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activateAwsStagingContinuousRuntime } from "../src/awsStagingRuntime.mjs";

export function activateAwsStagingRuntimeFiles({ envFile, jarManifestFile, runtimeManifestFile }) {
  const activated = activateAwsStagingContinuousRuntime(
    readFileSync(envFile, "utf8"),
    JSON.parse(readFileSync(runtimeManifestFile, "utf8")),
    JSON.parse(readFileSync(jarManifestFile, "utf8")),
  );
  atomicPrivateWrite(envFile, activated.envText);
  atomicPrivateWrite(runtimeManifestFile, `${JSON.stringify(activated.manifest, null, 2)}\n`);
  return Object.freeze({
    bundleSha256: activated.manifest.runtime.spark.artifacts.bundleSha256,
    continuousConfigured: true,
    jarCount: activated.manifest.runtime.spark.artifacts.jarCount,
  });
}

function atomicPrivateWrite(targetValue, content) {
  const target = path.resolve(targetValue);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const mapping = {
      "--env-file": "envFile",
      "--jar-manifest": "jarManifestFile",
      "--runtime-manifest": "runtimeManifestFile",
    };
    if (!value || !mapping[name]) throw new Error("Runtime activation arguments are invalid.");
    result[mapping[name]] = value;
  }
  if (!result.envFile || !result.jarManifestFile || !result.runtimeManifestFile) {
    throw new Error("Runtime activation file paths are required.");
  }
  return result;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = activateAwsStagingRuntimeFiles(parseArguments(process.argv.slice(2)));
    console.log(`ASKLAKE_AWS_STAGING_RUNTIME_ACTIVATED=${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`AWS staging Runtime activation failed (${error?.code || "INVALID_INPUT"}).`);
    process.exitCode = 1;
  }
}
