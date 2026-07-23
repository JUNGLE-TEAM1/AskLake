import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDemoEvent, PRODUCTS } from "./kafka-s3-refresh-demo-contract.mjs";

test("demo event uses an S3 product join key and stable identifiers", () => {
  const event = createDemoEvent({
    runId: "test-run",
    sequence: 1,
    now: new Date("2026-07-22T00:00:00.000Z"),
  });

  assert.equal(event.event_id, "test-run-000000001");
  assert.equal(event.event_time, "2026-07-22T00:00:00.000Z");
  assert.equal(event.product_id, PRODUCTS[0].productId);
  assert.equal(event.source, "kafka-s3-refresh-demo");
});

test("demo events rotate through every static product", () => {
  const ids = new Set(
    PRODUCTS.map((_, index) => createDemoEvent({ runId: "test-run", sequence: index + 1 }).product_id),
  );
  assert.deepEqual(ids, new Set(PRODUCTS.map((product) => product.productId)));
});

test("committed S3 CSV contains every Kafka product join key", async () => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const csvPath = path.resolve(scriptDir, "../fixtures/kafka-s3-refresh-demo/products.csv");
  const rows = (await readFile(csvPath, "utf8")).trim().split("\n");
  const csvProductIds = new Set(rows.slice(1).map((row) => row.split(",", 1)[0]));

  assert.deepEqual(csvProductIds, new Set(PRODUCTS.map((product) => product.productId)));
});
