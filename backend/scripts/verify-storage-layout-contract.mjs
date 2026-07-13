import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertProductionDataPlanePath,
  canonicalObjectStorageUri,
  createStorageLayout,
  normalizeObjectStorageError,
  storageLayoutConfig,
} from "../src/storageLayout.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(
  path.join(backendDir, "fixtures", "contracts", "storage-layout-v1.json"),
  "utf8",
));

for (const fixture of contract.cases) {
  const actual = createStorageLayout(fixture.input, fixture.environment);
  const comparable = Object.fromEntries(
    Object.keys(fixture.expected).map((name) => [name, actual[name]]),
  );
  assert.deepEqual(comparable, fixture.expected, fixture.name);
}

assert.deepEqual(storageLayoutConfig({}).retentionDays, contract.defaults.retentionDays);
assert.deepEqual(storageLayoutConfig({
  ASKLAKE_STORAGE_DATA_RETENTION_DAYS: "365",
  ASKLAKE_STORAGE_CHECKPOINT_RETENTION_DAYS: "7",
  ASKLAKE_STORAGE_MANIFEST_RETENTION_DAYS: "45",
  ASKLAKE_STORAGE_QUARANTINE_RETENTION_DAYS: "21",
  ASKLAKE_STORAGE_LOG_RETENTION_DAYS: "3",
}).retentionDays, {
  data: 365,
  checkpoints: 7,
  manifests: 45,
  quarantine: 21,
  logs: 3,
});

for (const fixture of contract.invalidCases) {
  assert.throws(
    () => canonicalObjectStorageUri(fixture.value, {}),
    (error) => error?.code === "STORAGE_LAYOUT_INVALID",
    fixture.name,
  );
}
assert.throws(
  () => assertProductionDataPlanePath("file:///tmp/output", { APP_ENV: "production" }),
  (error) => error?.code === "STORAGE_LAYOUT_LOCAL_PATH_FORBIDDEN",
);

const providerNeutralInput = {
  datasetId: "ds_provider_neutral",
  jobId: "JOB-PROVIDER",
  layer: "SILVER",
  runId: "RUN-PROVIDER",
};
const commonEnvironment = {
  ASKLAKE_SPARK_OUTPUT_BUCKET: "asklake-provider-test",
  ASKLAKE_STORAGE_ENVIRONMENT: "qa",
};
assert.deepEqual(
  createStorageLayout(providerNeutralInput, { ...commonEnvironment, ASKLAKE_OBJECT_STORAGE_PROVIDER: "minio" }),
  createStorageLayout(providerNeutralInput, { ...commonEnvironment, ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws" }),
  "Provider selection must not alter logical paths",
);
assert.notEqual(
  createStorageLayout({ ...providerNeutralInput, jobId: "JOB-A" }, commonEnvironment).checkpointPath,
  createStorageLayout({ ...providerNeutralInput, jobId: "JOB-B" }, commonEnvironment).checkpointPath,
  "Checkpoint roots must be isolated per Job",
);

const denied = normalizeObjectStorageError(
  { name: "AccessDenied", message: "secret=must-not-leak" },
  { bucket: "asklake-provider-test", operation: "bucket access" },
);
assert.equal(denied.code, "OBJECT_STORAGE_ACCESS_DENIED");
assert.equal(denied.status, 403);
assert.doesNotMatch(denied.message, /must-not-leak/);
assert.equal(normalizeObjectStorageError({ name: "NoSuchBucket" }).code, "OBJECT_STORAGE_NOT_FOUND");
assert.equal(normalizeObjectStorageError({ name: "TimeoutError" }).code, "OBJECT_STORAGE_UNAVAILABLE");

const configuredPython = process.env.ASKLAKE_FASTAPI_PYTHON;
const venvPython = path.join(backendDir, ".venv", "bin", "python");
const python = configuredPython || (existsSync(venvPython) ? venvPython : "python3");
const pythonResult = spawnSync(python, ["scripts/verify-storage-layout-contract.py"], {
  cwd: backendDir,
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: backendDir },
});
assert.equal(
  pythonResult.status,
  0,
  `Python Storage Layout verifier failed:\n${pythonResult.stdout}\n${pythonResult.stderr}`,
);

console.log("Storage Layout V1 Node/Python contract verification passed");
