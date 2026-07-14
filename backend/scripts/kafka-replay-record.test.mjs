import assert from "node:assert/strict";
import test from "node:test";

import { decorateReplayRecord } from "./kafka-replay-record.mjs";

test("loop replay makes envelope and nested source ids unique", () => {
  const original = {
    event_id: "EVT-1",
    offset: 1,
    raw: { event_id: "EVT-1", event_type: "product_click" },
  };

  const replay = decorateReplayRecord(original, 2, 31, { loop: true, replayRunId: "run-a" });

  assert.equal(replay.event_id, "EVT-1--run-run-a--cycle-000002--offset-31");
  assert.equal(replay.raw.event_id, replay.event_id);
  assert.equal(replay.offset, 31);
  assert.equal(original.raw.event_id, "EVT-1");
});

test("non-loop replay preserves the original record", () => {
  const original = { event_id: "EVT-1", offset: 1, raw: { event_id: "EVT-1" } };
  assert.equal(decorateReplayRecord(original, 1, 1, { loop: false, replayRunId: null }), original);
});

test("separate producer runs cannot generate the same replay id", () => {
  const original = { event_id: "EVT-1", offset: 1, raw: { event_id: "EVT-1" } };
  const first = decorateReplayRecord(original, 1, 1, { loop: true, replayRunId: "run-a" });
  const second = decorateReplayRecord(original, 1, 1, { loop: true, replayRunId: "run-b" });
  assert.notEqual(first.event_id, second.event_id);
  assert.notEqual(first.raw.event_id, second.raw.event_id);
});
