import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardWidgetDataRequests,
  dashboardWidgetDataRefreshRequests,
  dashboardWidgetDataRefreshRequestsForDatasets,
  dashboardPageDatasetIds,
  dashboardWidgetDataSignature,
  mergeDashboardWidgetData,
  runDashboardWidgetDataQueue,
  setDashboardWidgetDataStatus,
} from "../src/pages/dashboard/runtime/dashboardWidgetDataState.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

function widget(
  id: string,
  pageId: string,
  datasetId: string,
  dataStatus: DashboardRuntimeWidget["dataStatus"] = "pending",
): DashboardRuntimeWidget {
  return {
    config: { aggregation: "count", valueKey: "value" },
    data: [],
    dataStatus,
    datasetId,
    id,
    layout: { h: 3, w: 4, x: 0, y: 0 },
    pageId,
    title: id,
    type: "metric",
  };
}

function runtime(): DashboardRuntimeResponse {
  return {
    dashboard: {
      hasPublishedRevision: true,
      id: "dashboard-1",
      status: "published",
      title: "Dashboard",
      updatedAt: "2026-07-18T00:00:00Z",
    },
    eventCursor: 0,
    filters: [],
    mode: "published",
    pages: [
      { id: "page-1", orderIndex: 0, title: "Main" },
      { id: "page-2", orderIndex: 1, title: "Other" },
    ],
    revision: { id: "revision-1", kind: "published", version: 1 },
    widgetsByPageId: {
      "page-1": [
        widget("widget-1", "page-1", "orders"),
        widget("widget-2", "page-1", "orders"),
        widget("widget-3", "page-1", "users"),
      ],
      "page-2": [widget("widget-4", "page-2", "hidden-page")],
    },
  };
}

test("only the selected page is requested and widgets sharing a dataset are grouped", () => {
  const requests = dashboardWidgetDataRequests(runtime(), "page-1");

  assert.deepEqual(requests.map((request) => request.widgetIds), [
    ["widget-1", "widget-2"],
    ["widget-3"],
  ]);
  assert.equal(requests.flatMap((request) => request.widgetIds).includes("widget-4"), false);
});

test("manual refresh requests every Dataset widget on the selected page", () => {
  const current = runtime();
  current.widgetsByPageId["page-1"] = current.widgetsByPageId["page-1"].map((item) => ({
    ...item,
    data: [{ value: 3 }],
    dataStatus: "ready",
  }));

  const requests = dashboardWidgetDataRefreshRequests(current, "page-1");

  assert.deepEqual(requests.map((request) => request.widgetIds), [
    ["widget-1", "widget-2"],
    ["widget-3"],
  ]);
  assert.equal(requests.flatMap((request) => request.widgetIds).includes("widget-4"), false);
});

test("automatic invalidation refreshes only widgets for changed Datasets", () => {
  const current = runtime();
  const requests = dashboardWidgetDataRefreshRequestsForDatasets(
    current,
    "page-1",
    ["users"],
  );

  assert.deepEqual(dashboardPageDatasetIds(current, "page-1"), ["orders", "users"]);
  assert.deepEqual(requests.map((request) => request.widgetIds), [["widget-3"]]);
});

test("one widget result replaces only that widget and preserves unrelated object identity", () => {
  const current = runtime();
  const untouchedWidget = current.widgetsByPageId["page-1"][1];
  const untouchedPage = current.widgetsByPageId["page-2"];
  const currentWidget = current.widgetsByPageId["page-1"][0];
  const refreshed = { ...currentWidget, data: [{ value: 7 }], dataStatus: "ready" } as DashboardRuntimeWidget;

  const merged = mergeDashboardWidgetData(current, "dashboard-1", [refreshed], {
    [currentWidget.id]: dashboardWidgetDataSignature(currentWidget),
  });

  assert.deepEqual(merged?.widgetsByPageId["page-1"][0].data, [{ value: 7 }]);
  assert.equal(merged?.widgetsByPageId["page-1"][1], untouchedWidget);
  assert.equal(merged?.widgetsByPageId["page-2"], untouchedPage);
});

test("a response for an older widget configuration cannot overwrite a newer edit", () => {
  const current = runtime();
  const original = current.widgetsByPageId["page-1"][0];
  const expectedSignature = dashboardWidgetDataSignature(original);
  const edited = {
    ...original,
    config: { ...original.config, valueKey: "revenue" },
  } as DashboardRuntimeWidget;
  const editedRuntime = {
    ...current,
    widgetsByPageId: {
      ...current.widgetsByPageId,
      "page-1": [edited, ...current.widgetsByPageId["page-1"].slice(1)],
    },
  };
  const staleResponse = { ...original, data: [{ value: 999 }], dataStatus: "ready" } as DashboardRuntimeWidget;

  const merged = mergeDashboardWidgetData(editedRuntime, "dashboard-1", [staleResponse], {
    [original.id]: expectedSignature,
  });

  assert.equal(merged, editedRuntime);
  assert.deepEqual(merged.widgetsByPageId["page-1"][0].data, []);
});

test("a request error is attached only to the failed widget group", () => {
  const current = runtime();
  const next = setDashboardWidgetDataStatus(
    current,
    ["widget-3"],
    "error",
    "query failed",
  );

  assert.equal(next?.widgetsByPageId["page-1"][2].dataStatus, "error");
  assert.equal(next?.widgetsByPageId["page-1"][2].dataError, "query failed");
  assert.equal(next?.widgetsByPageId["page-1"][0], current.widgetsByPageId["page-1"][0]);
});

test("many Dataset groups never exceed the bounded request concurrency", async () => {
  const requests = Array.from({ length: 9 }, (_, index) => ({
    key: `dataset-${index}`,
    signatures: {},
    widgetIds: [`widget-${index}`],
  }));
  let active = 0;
  let maxActive = 0;
  const completed: string[] = [];

  await runDashboardWidgetDataQueue(requests, async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(request.key);
    active -= 1;
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(completed.sort(), requests.map((request) => request.key).sort());
});
