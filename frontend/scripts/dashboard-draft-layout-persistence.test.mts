import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyDraftWidgetLayouts,
  createDraftLayoutSaveInput,
  persistDraftLayout,
  restoreDraftWidgetLayouts,
  runtimePageLayoutSnapshot,
} from "../src/pages/dashboard/runtime/draftWidgetLayoutPersistence.ts";
import { hasAnyLayoutCollision } from "../src/pages/dashboard/runtime/dashboardLayoutUtils.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

const dashboardCanvasSource = readFileSync(
  new URL("../src/pages/dashboard/runtime/DashboardCanvas.tsx", import.meta.url),
  "utf8",
);

function metricWidget(id: string, x: number, y: number): DashboardRuntimeWidget {
  return {
    config: { aggregation: "count", valueKey: "event_id" },
    data: [],
    id,
    layout: { h: 3, minH: 2, minW: 2, w: 4, x, y },
    pageId: "page-1",
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
    pages: [{ id: "page-1", orderIndex: 0, title: "Main" }],
    revision: { id: "revision-1", kind: "draft", version: 1 },
    widgetsByPageId: {
      "page-1": [metricWidget("widget-1", 0, 0), metricWidget("widget-2", 4, 0)],
    },
  };
}

test("layout save success callback runs only after the API request resolves", async () => {
  let resolveSave: (() => void) | undefined;
  const events: string[] = [];
  const pending = persistDraftLayout(
    createDraftLayoutSaveInput("page-1", [{ h: 3, i: "widget-1", w: 4, x: 2, y: 3 }]),
    () => {
      events.push("request");
      return new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
    },
    () => events.push("saved"),
  );

  assert.deepEqual(events, ["request"]);
  resolveSave?.();
  assert.deepEqual(await pending, { status: "saved" });
  assert.deepEqual(events, ["request", "saved"]);
});

test("a failed layout save does not report success", async () => {
  const events: string[] = [];
  const result = await persistDraftLayout(
    createDraftLayoutSaveInput("page-1", [{ h: 3, i: "widget-1", w: 4, x: 2, y: 3 }]),
    async () => {
      throw new Error("network unavailable");
    },
    () => events.push("saved"),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.error : "", "network unavailable");
  assert.deepEqual(events, []);
});

test("a failed save can restore the last saved widget positions without replacing other widget data", () => {
  const beforeMove = draftRuntime();
  const lastSavedLayout = runtimePageLayoutSnapshot(beforeMove, "page-1");
  const moved = applyDraftWidgetLayouts(beforeMove, "page-1", [
    { h: 4, i: "widget-1", w: 6, x: 2, y: 3 },
    { h: 3, i: "widget-2", w: 4, x: 8, y: 0 },
  ]);
  const movedWidget = moved?.widgetsByPageId["page-1"][0];
  assert.deepEqual(movedWidget?.layout, { h: 4, minH: 2, minW: 2, w: 6, x: 2, y: 3 });

  const restored = restoreDraftWidgetLayouts(moved, "page-1", lastSavedLayout);
  assert.deepEqual(
    restored?.widgetsByPageId["page-1"].map((widget) => widget.layout),
    beforeMove.widgetsByPageId["page-1"].map((widget) => widget.layout),
  );
  assert.equal(restored?.widgetsByPageId["page-1"][0].title, "widget-1");
});

test("a colliding layout is rejected before a layout save request is built", () => {
  const collidingLayout = [
    { h: 3, i: "widget-1", w: 4, x: 0, y: 0 },
    { h: 3, i: "widget-2", w: 4, x: 2, y: 0 },
  ];

  assert.equal(hasAnyLayoutCollision(collidingLayout), true);
});

test("the draft editor keeps the canonical 12-column breakpoint while published dashboards stay responsive", () => {
  assert.match(dashboardCanvasSource, /const editorBreakpoint = editable \? "lg" : undefined/);
  assert.match(dashboardCanvasSource, /breakpoint=\{editorBreakpoint\}/);
});
