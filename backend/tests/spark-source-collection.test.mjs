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
