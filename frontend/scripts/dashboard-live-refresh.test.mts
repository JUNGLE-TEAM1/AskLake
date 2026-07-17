import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardLiveCatchUpDatasetIds,
  dashboardLiveDatasetIds,
  dashboardLivePollingStrategy,
  dashboardLiveRefreshInterval,
  mergePublishedDashboardWidgets,
  staleDashboardWidgetIds,
} from "../src/pages/dashboard/runtime/dashboardLiveRefresh.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

function metricWidget(overrides: Partial<Extract<DashboardRuntimeWidget, { type: "metric" }>> = {}) {
  return {
    appliedRevision: 4,
    calculatedAt: "2026-07-14T00:00:00Z",
    calculationVersion: "calculation-v1",
    config: { aggregation: "count", valueKey: "event_id" },
    data: [{ value: 4 }],
    datasetId: "clickstream_events",
    id: "widget-1",
    layout: { h: 2, w: 3, x: 0, y: 0 },
    liveRefresh: true,
    pageId: "page-1",
    queryId: null,
    title: "Click count",
    type: "metric",
    ...overrides,
  } satisfies Extract<DashboardRuntimeWidget, { type: "metric" }>;
}

function publishedRuntime(widgets: DashboardRuntimeWidget[] = [metricWidget()]): DashboardRuntimeResponse {
  return {
    dashboard: {
      hasPublishedRevision: true,
      id: "dashboard-1",
      status: "published",
      title: "Realtime commerce",
      updatedAt: "2026-07-14T00:00:00Z",
    },
    filters: [],
    mode: "published",
    pages: [{ id: "page-1", orderIndex: 0, title: "Main" }],
    revision: { id: "revision-1", kind: "published", version: 1 },
    widgetsByPageId: { "page-1": widgets },
  };
}

test("server polling hints use a safe fallback and 1-60 second bounds", () => {
  assert.equal(dashboardLiveRefreshInterval(undefined), 1_000);
  assert.equal(dashboardLiveRefreshInterval(Number.NaN), 1_000);
  assert.equal(dashboardLiveRefreshInterval(500), 1_000);
  assert.equal(dashboardLiveRefreshInterval(2_500.4), 2_500);
  assert.equal(dashboardLiveRefreshInterval(90_000), 60_000);
  const jittered = dashboardLiveRefreshInterval(1_000, "clickstream_events");
  assert.ok(jittered >= 1_000 && jittered <= 1_100);
  assert.equal(jittered, dashboardLiveRefreshInterval(1_000, "clickstream_events"));
});

test("an open SSE stream suspends polling while hybrid keeps only a safety poll", () => {
  assert.equal(dashboardLivePollingStrategy("polling", "open"), "normal");
  assert.equal(dashboardLivePollingStrategy("hybrid", "open"), "safety");
  assert.equal(dashboardLivePollingStrategy("sse", "open"), "suspended");
  assert.equal(dashboardLivePollingStrategy("sse", "degraded"), "normal");
  assert.equal(dashboardLivePollingStrategy("sse", "fallback_polling"), "normal");
});

test("published runtime groups each live dataset once", () => {
  const runtime = publishedRuntime([
    metricWidget({ id: "widget-1" }),
    metricWidget({ id: "widget-2" }),
    metricWidget({ datasetId: "orders", id: "widget-3", liveRefresh: false }),
  ]);

  assert.deepEqual(dashboardLiveDatasetIds(runtime, "dashboard-1"), ["clickstream_events"]);
  assert.deepEqual(dashboardLiveDatasetIds(runtime, "another-dashboard"), []);
  assert.deepEqual(dashboardLiveDatasetIds({ ...runtime, mode: "draft" }, "dashboard-1"), []);
});

test("only widgets behind a newer continuous dataset revision are refreshed", () => {
  const runtime = publishedRuntime([
    metricWidget({ appliedRevision: 4, id: "stale" }),
    metricWidget({ appliedRevision: 5, id: "current" }),
    metricWidget({ appliedRevision: 1, datasetId: "snapshot", id: "snapshot" }),
  ]);

  assert.deepEqual(staleDashboardWidgetIds(runtime, [
    {
      datasetId: "clickstream_events",
      isContinuous: true,
      latestRevision: 5,
      nextCheckAfterMs: 5_000,
      updatedAt: "2026-07-14T00:00:05Z",
    },
    {
      datasetId: "snapshot",
      isContinuous: false,
      latestRevision: 2,
      nextCheckAfterMs: 60_000,
      updatedAt: "2026-07-14T00:00:05Z",
    },
  ]), ["stale"]);
});

test("a refreshed widget replaces only its result and keeps the rest of the runtime", () => {
  const untouched = metricWidget({ datasetId: "orders", id: "widget-2", liveRefresh: false });
  const runtime = publishedRuntime([metricWidget(), untouched]);
  const refreshed = metricWidget({
    appliedRevision: 5,
    calculatedAt: "2026-07-14T00:00:05Z",
    data: [{ value: 12 }],
  });

  const merged = mergePublishedDashboardWidgets(runtime, "dashboard-1", [refreshed]);

  assert.notEqual(merged, runtime);
  assert.deepEqual(merged?.widgetsByPageId["page-1"][0].data, [{ value: 12 }]);
  assert.equal(merged?.widgetsByPageId["page-1"][0].appliedRevision, 5);
  assert.equal(merged?.widgetsByPageId["page-1"][1], untouched);
  assert.equal(mergePublishedDashboardWidgets(runtime, "another-dashboard", [refreshed]), runtime);
});

test("partial widget revisions stay in fast catch-up until they reach freshness", () => {
  const freshness = [{
    datasetId: "clickstream_events",
    isContinuous: true,
    latestRevision: 8,
    nextCheckAfterMs: 5_000,
    updatedAt: "2026-07-14T00:00:08Z",
  }];

  assert.deepEqual(
    dashboardLiveCatchUpDatasetIds(publishedRuntime([
      metricWidget({ appliedRevision: 6, id: "partial-1" }),
      metricWidget({ appliedRevision: 6, id: "partial-2" }),
    ]), [
      metricWidget({ appliedRevision: 7, id: "partial-1" }),
      metricWidget({ appliedRevision: 7, id: "partial-2" }),
    ], freshness),
    ["clickstream_events"],
  );
  assert.deepEqual(
    dashboardLiveCatchUpDatasetIds(publishedRuntime([
      metricWidget({ appliedRevision: 7 }),
    ]), [
      metricWidget({ appliedRevision: 7 }),
    ], freshness),
    [],
  );
  assert.deepEqual(
    dashboardLiveCatchUpDatasetIds(publishedRuntime([
      metricWidget({ appliedRevision: 7 }),
    ]), [
      metricWidget({ appliedRevision: 8 }),
    ], freshness),
    [],
  );
});
