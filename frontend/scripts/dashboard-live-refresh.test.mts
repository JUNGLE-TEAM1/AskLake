import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardCursorFromFreshness,
  dashboardFreshnessRequiresSnapshot,
  dashboardLiveCatchUpDatasetIds,
  dashboardLiveDatasetIds,
  dashboardLivePollingStrategy,
  dashboardLiveRefreshInterval,
  mergePublishedDashboardWidgets,
  planDashboardRealtimeRefresh,
  publishedDashboardUsesManualRefresh,
  staleDashboardWidgetIds,
} from "../src/pages/dashboard/runtime/dashboardLiveRefresh.ts";
import type { RealtimeDatasetEventV2 } from "../src/services/realtimeEvents.ts";
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

test("dashboards enable automatic revision refresh", () => {
  assert.equal(publishedDashboardUsesManualRefresh(), false);
});

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

function freshness(overrides: Record<string, unknown> = {}) {
  return {
    activeArchiveSnapshotId: "archive-7",
    activeServingEngine: "clickhouse",
    activeServingVersionId: "serving-v7",
    bindingEpoch: 7,
    datasetId: "clickstream_events",
    isContinuous: true,
    latestChecksum: "checksum-7",
    latestMutationType: "upsert" as const,
    latestRevision: 7,
    latestSourceBoundary: { partitions: [] },
    nextCheckAfterMs: 1_000,
    updatedAt: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

function realtimeV2(overrides: Partial<RealtimeDatasetEventV2> = {}): RealtimeDatasetEventV2 {
  return {
    aggregateRevision: 8,
    correlationId: "materialization-8",
    eventId: 8,
    eventType: "dataset.revision.committed",
    invalidate: ["dataset:clickstream_events"],
    occurredAt: "2026-07-18T00:00:08Z",
    payload: {
      bindingEpoch: 7,
      materializationId: "materialization-8",
      mutationType: "upsert",
      pipelineVersionId: "pipeline-v7",
      servingVersionId: "serving-v7",
      sourceBoundary: { partitions: [] },
    },
    resourceId: "clickstream_events",
    resourceType: "dataset",
    schemaVersion: 2,
    scopeId: "deployment",
    ...overrides,
  };
}

test("dataset cursor plans targeted refresh and promotes gaps, replace, or binding changes to snapshot", () => {
  const current = dashboardCursorFromFreshness(freshness({ latestRevision: 7 }));
  assert.equal(planDashboardRealtimeRefresh(current, realtimeV2()).action, "targeted");
  assert.equal(planDashboardRealtimeRefresh(
    { ...current, eventCursor: 8, revision: 8 },
    realtimeV2(),
  ).action, "ignore");
  assert.equal(planDashboardRealtimeRefresh(
    current,
    realtimeV2({ aggregateRevision: 10, eventId: 10 }),
  ).reason, "revision_gap");
  assert.equal(planDashboardRealtimeRefresh(current, realtimeV2({
    payload: { ...realtimeV2().payload, mutationType: "replace" },
  })).reason, "mutation_replace");
  assert.equal(planDashboardRealtimeRefresh(current, realtimeV2({
    aggregateRevision: 1,
    eventId: 9,
    payload: { ...realtimeV2().payload, bindingEpoch: 8 },
  })).reason, "binding_changed");
  assert.equal(dashboardFreshnessRequiresSnapshot(current, freshness({ bindingEpoch: 8 })), true);
});

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

test("runtime groups each dashboard dataset once in both view and edit modes", () => {
  const runtime = publishedRuntime([
    metricWidget({ id: "widget-1" }),
    metricWidget({ id: "widget-2" }),
    metricWidget({ datasetId: "orders", id: "widget-3", liveRefresh: false }),
  ]);

  assert.deepEqual(dashboardLiveDatasetIds(runtime, "dashboard-1"), ["clickstream_events", "orders"]);
  assert.deepEqual(dashboardLiveDatasetIds(runtime, "another-dashboard"), []);
  assert.deepEqual(dashboardLiveDatasetIds({ ...runtime, mode: "draft" }, "dashboard-1"), ["clickstream_events", "orders"]);
});

test("live polling waits until the selected widget has loaded its first result", () => {
  const runtime = publishedRuntime([
    metricWidget({ dataStatus: "pending" }),
  ]);

  assert.deepEqual(dashboardLiveDatasetIds(runtime, "dashboard-1"), []);
  assert.deepEqual(staleDashboardWidgetIds(runtime, [{
    datasetId: "clickstream_events",
    isContinuous: true,
    latestRevision: 5,
    nextCheckAfterMs: 1_000,
    updatedAt: "2026-07-14T00:00:05Z",
  }]), []);
});

test("only widgets behind a newer dataset revision are refreshed", () => {
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
  ]), ["stale", "snapshot"]);
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

test("an older widget response cannot overwrite a newer applied revision", () => {
  const runtime = publishedRuntime([metricWidget({ appliedRevision: 8 })]);
  const merged = mergePublishedDashboardWidgets(runtime, "dashboard-1", [metricWidget({ appliedRevision: 7, data: [{ value: 7 }] })]);
  assert.equal(merged, runtime);
  assert.deepEqual(merged?.widgetsByPageId["page-1"][0].data, [{ value: 4 }]);
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
