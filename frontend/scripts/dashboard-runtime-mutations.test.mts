import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRuntimePage,
  removeRuntimePage,
  removeRuntimeWidget,
  upsertRuntimeWidget,
} from "../src/pages/dashboard/runtime/dashboardRuntimeMutations.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

function metricWidget(id: string, pageId: string, value: number): DashboardRuntimeWidget {
  return {
    config: { aggregation: "count", valueKey: "value" },
    data: [{ value }],
    id,
    layout: { h: 3, w: 4, x: 0, y: 0 },
    pageId,
    title: id,
    type: "metric",
  };
}

function draftRuntime(): DashboardRuntimeResponse {
  return {
    dashboard: {
      hasPublishedRevision: false,
      id: "dashboard-1",
      status: "draft",
      title: "Draft dashboard",
      updatedAt: "2026-07-18T00:00:00Z",
    },
    eventCursor: 0,
    filters: [],
    mode: "draft",
    pages: [
      { id: "page-1", orderIndex: 0, title: "Main" },
      { id: "page-2", orderIndex: 1, title: "Details" },
    ],
    revision: { id: "revision-1", kind: "draft", version: 1 },
    widgetsByPageId: {
      "page-1": [metricWidget("widget-1", "page-1", 1), metricWidget("widget-2", "page-1", 2)],
      "page-2": [metricWidget("widget-3", "page-2", 3)],
    },
  };
}

test("a saved widget replaces only that widget without reloading unrelated state", () => {
  const runtime = draftRuntime();
  const untouchedWidget = runtime.widgetsByPageId["page-1"][1];
  const untouchedPageWidgets = runtime.widgetsByPageId["page-2"];
  const savedWidget = metricWidget("widget-1", "page-1", 10);

  const nextRuntime = upsertRuntimeWidget(runtime, savedWidget);

  assert.equal(nextRuntime.widgetsByPageId["page-1"][0], savedWidget);
  assert.equal(nextRuntime.widgetsByPageId["page-1"][1], untouchedWidget);
  assert.equal(nextRuntime.widgetsByPageId["page-2"], untouchedPageWidgets);
});

test("page and widget mutations preserve every unrelated object", () => {
  const runtime = draftRuntime();
  const existingPage = runtime.pages[0];
  const existingWidget = runtime.widgetsByPageId["page-1"][0];
  const addedPage = { id: "page-3", orderIndex: 2, title: "New page" };

  const afterAdd = appendRuntimePage(runtime, addedPage);
  assert.equal(afterAdd.pages[0], existingPage);
  assert.equal(afterAdd.widgetsByPageId["page-1"], runtime.widgetsByPageId["page-1"]);

  const afterWidgetDelete = removeRuntimeWidget(afterAdd, "widget-2");
  assert.equal(afterWidgetDelete.widgetsByPageId["page-1"][0], existingWidget);
  assert.equal(afterWidgetDelete.widgetsByPageId["page-2"], runtime.widgetsByPageId["page-2"]);

  const afterPageDelete = removeRuntimePage(afterWidgetDelete, "page-3");
  assert.deepEqual(afterPageDelete.pages.map((page) => page.id), ["page-1", "page-2"]);
  assert.equal(afterPageDelete.widgetsByPageId["page-1"][0], existingWidget);
  assert.equal("page-3" in afterPageDelete.widgetsByPageId, false);
});
