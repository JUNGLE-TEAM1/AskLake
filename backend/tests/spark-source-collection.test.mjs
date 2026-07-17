import assert from "node:assert/strict";
import test from "node:test";

import {
  sourceCollectionFromConfig,
  sparkRowLimitFromJob,
  sparkSourceFromJob,
} from "../src/sparkRunner.mjs";

test("incremental folder manifest carries a fixed object inventory", () => {
  const collection = sourceCollectionFromConfig(
    [
      ["Collection Scope", "folder"],
      ["Collection Mode", "incremental"],
      ["File Pattern", "*.jsonl"],
      ["Recursive", "false"],
    ],
    "2026-07-12T10:00:00Z",
    "2026-07-12T11:00:00Z",
    1,
    false,
    ["incoming/b.jsonl", "incoming/a.jsonl", "incoming/a.jsonl"],
  );

  assert.deepEqual(collection, {
    filePattern: "*.jsonl",
    incrementalBefore: "2026-07-12T11:00:00Z",
    incrementalSince: "2026-07-12T10:00:00Z",
    mode: "incremental",
    objectKeys: ["incoming/a.jsonl", "incoming/b.jsonl"],
    rebaseline: false,
    recursive: false,
    scope: "folder",
    windowContractVersion: 1,
  });
});

test("single file sources remain full snapshots without object inventory", () => {
  const collection = sourceCollectionFromConfig(
    [["Collection Scope", "file"]],
    undefined,
    undefined,
    undefined,
    false,
    ["ignored.jsonl"],
  );

  assert.equal(collection.scope, "file");
  assert.equal(collection.mode, "full");
  assert.equal(collection.objectKeys, null);
  assert.equal(collection.windowContractVersion, null);
});

test("v2 incremental manifest preserves sorted object identities and version ids", () => {
  const collection = sourceCollectionFromConfig(
    [
      ["Collection Scope", "folder"],
      ["Collection Mode", "incremental"],
    ],
    "2026-07-12T10:00:00Z",
    "2026-07-12T11:00:00Z",
    2,
    true,
    ["incoming/b.jsonl", "incoming/a.jsonl"],
    [
      {
        key: "incoming/b.jsonl",
        eTag: '"etag-b"',
        versionId: null,
        lastModified: "2026-07-12T10:30:00.000Z",
        size: 20,
      },
      {
        Key: "incoming/a.jsonl",
        ETag: '"etag-a"',
        VersionId: "version-a",
        LastModified: "2026-07-12T10:15:00.000Z",
        Size: 10,
      },
    ],
  );

  assert.deepEqual(collection.objectKeys, ["incoming/a.jsonl", "incoming/b.jsonl"]);
  assert.equal(collection.rebaseline, true);
  assert.deepEqual(collection.objectInventory, [
    {
      key: "incoming/a.jsonl",
      eTag: "etag-a",
      versionId: "version-a",
      lastModified: "2026-07-12T10:15:00.000Z",
      size: 10,
    },
    {
      key: "incoming/b.jsonl",
      eTag: "etag-b",
      versionId: null,
      lastModified: "2026-07-12T10:30:00.000Z",
      size: 20,
    },
  ]);
  assert.equal(collection.windowContractVersion, 2);
});

test("v2 manifest leaves invalid identity inventory fail-closed", () => {
  const collection = sourceCollectionFromConfig(
    [
      ["Collection Scope", "folder"],
      ["Collection Mode", "incremental"],
    ],
    undefined,
    "2026-07-12T11:00:00Z",
    2,
    true,
    ["incoming/a.jsonl"],
    [{
      key: "incoming/a.jsonl",
      eTag: "etag-a",
      lastModified: "2026-07-12T10:15:00.000Z",
      size: "",
    }],
  );

  assert.equal(collection.objectInventory, null);
  assert.deepEqual(collection.objectKeys, ["incoming/a.jsonl"]);
});

test("schema sampling scope never truncates the execution dataset", () => {
  const previous = process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT;
  try {
    delete process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT;
    assert.equal(sparkRowLimitFromJob({
      sourceConfig: [["__Schema Sample Scope", "slice1gb"]],
      sourceType: "File / S3",
    }), "0");
    assert.equal(sparkRowLimitFromJob({
      sourceConfig: [["__Execution Row Limit", "125"]],
      sourceType: "File / S3",
    }), "125");
  } finally {
    if (previous === undefined) delete process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT;
    else process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT = previous;
  }
});

test("Data Lake execution fails closed when neither an Iceberg table nor a path exists", () => {
  assert.throws(
    () => sparkSourceFromJob({ sourceConfig: [], sourceType: "Data Lake" }, "run-missing-lake"),
    (error) => error?.code === "SPARK_RUN_FAILED" && /requires an Iceberg table or explicit Path/i.test(error.message),
  );
});

test("connector preview rows cannot masquerade as a full Spark execution source", () => {
  assert.throws(
    () => sparkSourceFromJob({
      schemaColumns: [{ sourceName: "id", targetName: "id" }],
      schemaSampleRows: [["sample-only"]],
      sourceConfig: [["Endpoint URL", "https://example.invalid/events"]],
      sourceType: "REST API",
    }, "run-rest-preview"),
    (error) => error?.code === "SPARK_RUN_FAILED" && /full-dataset execution adapter/i.test(error.message),
  );
});

test("inline sample execution is disabled outside an explicit test runtime", () => {
  const previousAppEnv = process.env.APP_ENV;
  const previousEnabled = process.env.ASKLAKE_ENABLE_TEST_SAMPLE_SOURCE;
  try {
    delete process.env.APP_ENV;
    delete process.env.ASKLAKE_ENABLE_TEST_SAMPLE_SOURCE;
    assert.throws(
      () => sparkSourceFromJob({
        schemaColumns: [{ sourceName: "id", targetName: "id" }],
        schemaSampleRows: [["fixture"]],
        sourceConfig: [["Endpoint URL", "sample://inline"]],
        sourceType: "REST API",
      }, "run-inline-sample"),
      (error) => error?.code === "SPARK_RUN_FAILED" && /restricted to explicit test runtime/i.test(error.message),
    );
  } finally {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
    if (previousEnabled === undefined) delete process.env.ASKLAKE_ENABLE_TEST_SAMPLE_SOURCE;
    else process.env.ASKLAKE_ENABLE_TEST_SAMPLE_SOURCE = previousEnabled;
  }
});

test("fixed S3 selections carry the preview inventory contract into the Spark manifest", () => {
  const collection = sourceCollectionFromConfig([
    ["__Selection Kind", "prefix"],
    ["__Source Unit Count", "3"],
    ["__Source Total Bytes", "420"],
    ["__Source Inventory Fingerprint", "a".repeat(64)],
    ["__Source Identity Contract Version", "1"],
  ]);

  assert.equal(collection.selectionKind, "prefix");
  assert.equal(collection.expectedFileCount, 3);
  assert.equal(collection.expectedTotalBytes, 420);
  assert.equal(collection.expectedInventoryFingerprint, "a".repeat(64));
  assert.equal(collection.selectionIdentityContractVersion, 1);
});
