import assert from "node:assert/strict";
import test from "node:test";

import {
  mapSettledWithConcurrency,
  prefixInitialSampleBytes,
  prefixValidationConcurrency,
  readAdaptivePrefixSample,
} from "../src/prefixSampleValidation.mjs";

test("prefix validation configuration applies defaults and safety bounds", () => {
  assert.equal(prefixValidationConcurrency({}), 8);
  assert.equal(prefixValidationConcurrency({ ASKLAKE_PREFIX_VALIDATION_CONCURRENCY: "4" }), 4);
  assert.equal(prefixValidationConcurrency({ ASKLAKE_PREFIX_VALIDATION_CONCURRENCY: "0" }), 8);
  assert.equal(prefixValidationConcurrency({ ASKLAKE_PREFIX_VALIDATION_CONCURRENCY: "100" }), 32);
  assert.equal(prefixValidationConcurrency({ ASKLAKE_PREFIX_VALIDATION_CONCURRENCY: "invalid" }), 8);

  assert.equal(prefixInitialSampleBytes({}), 64 * 1024);
  assert.equal(prefixInitialSampleBytes({ ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES: "8192" }), 8192);
  assert.equal(prefixInitialSampleBytes({ ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES: "1024" }), 4096);
  assert.equal(prefixInitialSampleBytes({ ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES: "invalid" }), 64 * 1024);
});

test("bounded worker pool preserves input order and caps active work", async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;

  const results = await mapSettledWithConcurrency(items, 4, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3 === 0 ? 12 : 4));
    active -= 1;
    if (value === 7) throw new Error("expected failure");
    return value * 2;
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(
    results.map((result) => result.status === "fulfilled" ? result.value : result.reason.message),
    [0, 2, 4, 6, 8, 10, 12, "expected failure", 16, 18, 20, 22],
  );
});

test("adaptive CSV sampling stops after the first bounded range when rows are sufficient", async () => {
  const headerAndRows = [
    "id,name,amount",
    ...Array.from({ length: 20 }, (_, index) => `${index + 1},user-${index + 1},${index + 100}`),
  ].join("\n");
  const content = Buffer.from(`${headerAndRows}\n${"padding,padding,padding\n".repeat(4000)}`, "utf8");
  const ranges = [];

  const result = await readAdaptivePrefixSample({
    initialBytes: 64 * 1024,
    key: "dataset/part-000.csv",
    maxBytes: 512 * 1024,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => {
      ranges.push([startByte, endByte]);
      return content.subarray(startByte, endByte + 1);
    },
    rowLimit: 10,
  });

  assert.deepEqual(ranges, [[0, (64 * 1024) - 1]]);
  assert.equal(result.requestedBytes, 64 * 1024);
  assert.equal(result.parsedSample.columns.join(","), "id,name,amount");
  assert.equal(result.parsedSample.rows.length, 10);
});

test("adaptive JSONL sampling expands with non-overlapping ranges and drops an incomplete tail", async () => {
  const records = [
    { event_id: "evt-1", label: "첫 번째" },
    { event_id: "evt-2", label: "두 번째" },
    { event_id: "evt-3", label: "세 번째" },
    { event_id: "evt-4", label: "네 번째" },
  ];
  const content = Buffer.from(`${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const ranges = [];

  const result = await readAdaptivePrefixSample({
    initialBytes: 32,
    key: "dataset/part-000.jsonl",
    maxBytes: content.length,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => {
      ranges.push([startByte, endByte]);
      return content.subarray(startByte, endByte + 1);
    },
    rowLimit: 3,
  });

  assert.ok(ranges.length > 1);
  for (let index = 1; index < ranges.length; index += 1) {
    assert.equal(ranges[index][0], ranges[index - 1][1] + 1);
  }
  assert.deepEqual(result.parsedSample.columns, ["event_id", "label"]);
  assert.deepEqual(result.parsedSample.rows.slice(0, 3), [
    ["evt-1", "첫 번째"],
    ["evt-2", "두 번째"],
    ["evt-3", "세 번째"],
  ]);
});

test("adaptive JSON array sampling stops after enough complete objects", async () => {
  const content = Buffer.from(JSON.stringify(
    Array.from({ length: 20 }, (_, index) => ({
      event_id: `evt-${index + 1}`,
      payload: "x".repeat(48),
    })),
  ), "utf8");
  const ranges = [];

  const result = await readAdaptivePrefixSample({
    initialBytes: 80,
    key: "dataset/part-000.json",
    maxBytes: content.length,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => {
      ranges.push([startByte, endByte]);
      return content.subarray(startByte, endByte + 1);
    },
    rowLimit: 3,
  });

  assert.ok(ranges.length > 1);
  assert.ok(result.requestedBytes < content.length);
  assert.deepEqual(result.parsedSample.columns, ["event_id", "payload"]);
  assert.deepEqual(
    result.parsedSample.rows.map(([eventId]) => eventId),
    ["evt-1", "evt-2", "evt-3"],
  );
});

test("adaptive TXT sampling expands until it has complete lines", async () => {
  const content = Buffer.from([
    "first line is longer than the first range",
    "second line is complete",
    "third line is not needed",
  ].join("\n"), "utf8");
  const ranges = [];

  const result = await readAdaptivePrefixSample({
    initialBytes: 16,
    key: "dataset/events.txt",
    maxBytes: content.length,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => {
      ranges.push([startByte, endByte]);
      return content.subarray(startByte, endByte + 1);
    },
    rowLimit: 2,
  });

  assert.ok(ranges.length > 1);
  assert.deepEqual(result.parsedSample.rows, [
    ["1", "first line is longer than the first range"],
    ["2", "second line is complete"],
  ]);
});

test("adaptive sampling accepts a small file at EOF before the requested row count", async () => {
  const content = Buffer.from("id,name\n1,Alice\n2,Bob", "utf8");
  const result = await readAdaptivePrefixSample({
    initialBytes: 64 * 1024,
    key: "dataset/small.csv",
    maxBytes: 512 * 1024,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => content.subarray(startByte, endByte + 1),
    rowLimit: 10,
  });

  assert.equal(result.reachedEnd, true);
  assert.equal(result.requestedBytes, content.length);
  assert.deepEqual(result.parsedSample.rows, [["1", "Alice"], ["2", "Bob"]]);
});

test("adaptive sampling never reads beyond its effective maximum", async () => {
  const content = Buffer.from(`id,payload\n1,${"x".repeat(1024)}`, "utf8");
  const ranges = [];
  const result = await readAdaptivePrefixSample({
    initialBytes: 16,
    key: "dataset/long.csv",
    maxBytes: 64,
    objectSize: content.length,
    readRange: async ({ endByte, startByte }) => {
      ranges.push([startByte, endByte]);
      return content.subarray(startByte, endByte + 1);
    },
    rowLimit: 10,
  });

  assert.equal(result.requestedBytes, 64);
  assert.equal(ranges.at(-1)[1], 63);
  assert.ok(result.parsedSample.columns.length > 0);
  assert.deepEqual(result.parsedSample.rows, []);
});
