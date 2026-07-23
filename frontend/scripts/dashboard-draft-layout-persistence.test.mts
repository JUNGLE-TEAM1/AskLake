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
import { layoutFromDraft } from "../src/pages/dashboard/runtime/widgetLayoutEditor.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

const dashboardCanvasSource = readFileSync(
  new URL("../src/pages/dashboard/runtime/DashboardCanvas.tsx", import.meta.url),
  "utf8",
);
const dashboardRuntimeViewSource = readFileSync(
  new URL("../src/pages/dashboard/runtime/DashboardRuntimeView.tsx", import.meta.url),
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

test("the draft editor defaults to the canonical 12-column breakpoint while allowing an explicit preview", () => {
  assert.match(
    dashboardCanvasSource,
    /const editorBreakpoint(?:: DashboardBreakpoint \| undefined)? = previewBreakpoint \?\? \(editable \? "lg" : undefined\)/,
  );
  assert.match(dashboardCanvasSource, /breakpoint=\{editorBreakpoint\}/);
});

test("desktop dashboards preserve intentional gaps and block colliding widget moves", () => {
  assert.match(
    dashboardCanvasSource,
    /import \{ Responsive, noCompactor, useContainerWidth, verticalCompactor, type Layout, type LayoutItem \} from "react-grid-layout";/,
  );
  assert.match(dashboardCanvasSource, /const fixedDesktopCompactor = \{ \.\.\.noCompactor, preventCollision: true \};/);
  assert.match(dashboardCanvasSource, /const preservesManualPlacement = editable \|\| activeBreakpoint === "lg" \|\| activeBreakpoint === "md";/);
  assert.match(
    dashboardCanvasSource,
    /compactor=\{preservesManualPlacement \? fixedDesktopCompactor : verticalCompactor\}/,
  );
  assert.match(dashboardCanvasSource, /onBreakpointChange=\{\(breakpoint\) => setActiveBreakpoint\(breakpoint\)\}/);
});

test("coordinate editor preserves widget limits and rejects positions outside the 12-column canvas", () => {
  const widget = metricWidget("widget-1", 0, 0);
  assert.deepEqual(
    layoutFromDraft(widget, { h: "4", w: "6", x: "6", y: "3" }),
    { h: 4, minH: 2, minW: 2, w: 6, x: 6, y: 3 },
  );
  assert.equal(
    layoutFromDraft(widget, { h: "4", w: "6", x: "7", y: "3" }),
    "X 좌표와 너비의 합이 12열을 넘을 수 없습니다.",
  );
  assert.equal(
    layoutFromDraft(widget, { h: "1", w: "6", x: "0", y: "3" }),
    "이 위젯의 최소 크기는 2열 × 2행입니다.",
  );
});

test("draft previews use read-only responsive breakpoints while published dashboards render the saved grid", () => {
  assert.match(dashboardCanvasSource, /previewBreakpoint \?\? \(editable \? "lg" : undefined\)/);
  assert.match(dashboardCanvasSource, /preview-\$\{previewBreakpoint\}/);
  assert.match(dashboardRuntimeViewSource, /const \[layoutPreviewBreakpoint, setLayoutPreviewBreakpoint\] = useState<"lg" \| "sm" \| "xs">\("lg"\);/);
  assert.match(dashboardRuntimeViewSource, /editable=\{layoutPreviewBreakpoint === "lg"\}/);
  assert.match(dashboardRuntimeViewSource, /previewBreakpoint=\{layoutPreviewBreakpoint\}/);
  assert.match(dashboardRuntimeViewSource, /<DashboardCanvas editable=\{false\} widgets=\{selectedPublishedWidgets\} onRetryWidgetData=\{onRetryWidgetData\} \/>/);
});
