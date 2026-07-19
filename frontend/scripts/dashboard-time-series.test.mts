import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedTimeSeriesSlice,
  bucketTimeLabel,
  defaultTimeBucketForColumn,
  formatTimeAxisLabel,
  latestTimeSeriesSlice,
  timeSeriesCategoryTimestamps,
} from "../src/pages/dashboard/runtime/timeSeries.ts";

test("minute and hour buckets retain the selected wall-clock precision", () => {
  assert.equal(bucketTimeLabel("2026-07-19T12:34:56", "minute"), "2026-07-19T12:34:00");
  assert.equal(bucketTimeLabel("2026-07-19T12:34:56", "hour"), "2026-07-19T12:00:00");
  assert.equal(bucketTimeLabel("2026-07-19T12:34:56", "day"), "2026-07-19");
});

test("time categories become a chronological datetime axis while ordinary categories stay categorical", () => {
  const timestamps = timeSeriesCategoryTimestamps([
    "2026-07-19T12:00:00",
    "2026-07-19T12:01:00",
    "2026-07-19T12:02:00",
  ]);
  assert.ok(timestamps);
  assert.equal(timestamps.length, 3);
  assert.ok(timestamps[0] < timestamps[1]);
  assert.ok(timestamps[1] < timestamps[2]);
  assert.equal(timeSeriesCategoryTimestamps(["mobile", "desktop"]), null);
});

test("time series keeps the newest bounded points", () => {
  assert.deepEqual(latestTimeSeriesSlice([1, 2, 3, 4, 5], 3), [3, 4, 5]);
  assert.deepEqual(latestTimeSeriesSlice([1, 2], 10), [1, 2]);
  assert.deepEqual(
    boundedTimeSeriesSlice([1, 2, 3, 4], ["2026-07-19T12:00:00", "2026-07-19T12:01:00", "2026-07-19T12:02:00", "2026-07-19T12:03:00"], 2),
    [3, 4],
  );
  assert.deepEqual(boundedTimeSeriesSlice([1, 2, 3, 4], ["alpha", "beta", "gamma", "omega"], 2), [1, 2]);
});

test("timestamp columns default to an hourly bucket and date columns default to a daily bucket", () => {
  assert.equal(defaultTimeBucketForColumn({ name: "event_time", type: "date" }), "hour");
  assert.equal(defaultTimeBucketForColumn({ name: "created_at", type: "date" }), "hour");
  assert.equal(defaultTimeBucketForColumn({ name: "order_date", type: "date" }), "day");
  assert.equal(defaultTimeBucketForColumn({ name: "category", type: "string" }), undefined);
});

test("time-axis labels are human-readable", () => {
  const label = formatTimeAxisLabel(Date.parse("2026-07-19T12:34:00"), "minute", true);
  assert.match(label, /12/);
  assert.match(label, /34/);
});
