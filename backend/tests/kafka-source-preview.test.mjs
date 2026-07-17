import assert from "node:assert/strict";
import test from "node:test";

import { buildKafkaPreviewMetadata } from "../src/kafkaPreview.mjs";
import { inferSchemaColumns, parseSourceSample } from "../src/profile.mjs";

test("click-events JSON envelope remains the original Kafka value", () => {
  const message = JSON.stringify({
    source: "click-events-log",
    raw: {
      event_time: "2026-06-12T14:21:32+09:00",
      event_id: "EVT-000000001",
      user_id: "USR-0000001",
      session_id: "SES-00000001",
      event_type: "product_impression",
      product_id: "B07WMTD66B",
      page_url: "/search?category=Camera+%26+Photo",
      device_type: "mobile",
      referrer: "email",
      position: 1,
    },
  });
  const metadata = buildKafkaPreviewMetadata([message], "jsonl");

  assert.equal(metadata.detectedFormat, "JSONL");
  assert.deepEqual(metadata.rawPreviewLines, [message]);
  assert.equal(metadata.requiresRecordParsing, false);

  const parsed = parseSourceSample("click-events.jsonl", message);
  assert.ok(parsed.columns.includes("raw.event_id"));
  assert.ok(parsed.columns.includes("raw.position"));
  assert.equal(
    inferSchemaColumns(parsed).find((column) => column.sourceName === "raw.position")?.type,
    "Long",
  );
});

test("generic structured Kafka JSON is not forced into record parsing", () => {
  const message = JSON.stringify({ event_id: "EVT-1" });
  assert.deepEqual(buildKafkaPreviewMetadata([message], "jsonl"), {
    detectedFormat: "JSONL",
    rawPreviewLines: [message],
    requiresRecordParsing: false,
  });
});

test("Kafka raw text alone requires record parsing", () => {
  const message = "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001";
  assert.deepEqual(buildKafkaPreviewMetadata([message], "txt"), {
    detectedFormat: "TXT",
    rawPreviewLines: [message],
    requiresRecordParsing: true,
  });
});
