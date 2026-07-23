import assert from "node:assert/strict";
import test from "node:test";

import { sourceCollectionFromConfig } from "../src/sparkRunner.mjs";

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
