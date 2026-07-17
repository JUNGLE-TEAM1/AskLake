import assert from "node:assert/strict";
import test from "node:test";

import { recoverKafkaLogLines } from "../src/kafkaPreview.mjs";

test("click-events log envelope recovers the original ten-field record", () => {
  const line = recoverKafkaLogLines([JSON.stringify({
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
  })]);

  assert.deepEqual(line, [
    "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001 SES-00000001 product_impression B07WMTD66B /search?category=Camera+%26+Photo mobile email 1",
  ]);
});

test("generic structured Kafka JSON is not forced into record parsing", () => {
  assert.deepEqual(recoverKafkaLogLines([JSON.stringify({ event_id: "EVT-1" })]), []);
});
