import type { LayoutItem } from "react-grid-layout";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget, DashboardWidgetLayout } from "../../../types";

export type RuntimeLayoutSnapshot = Array<
  Pick<LayoutItem, "h" | "i" | "minH" | "minW" | "w" | "x" | "y">
>;

export type DraftLayoutSaveInput = {
  layouts: Array<DashboardWidgetLayout & { widgetId: string }>;
  pageId: string;
};

export type DraftLayoutSaveResult =
  | { status: "saved" }
  | { error: string; status: "failed" };

export type DraftLayoutUpdateResult =
  | { previousSavedLayout: RuntimeLayoutSnapshot; status: "saved" }
  | { status: "failed" | "rejected" };

export function normalizeLayoutSnapshot(layout: readonly LayoutItem[]): RuntimeLayoutSnapshot {
  return layout
    .map((item) => ({
      h: item.h,
      i: item.i,
      minH: item.minH,
      minW: item.minW,
      w: item.w,
      x: item.x,
      y: item.y,
    }))
    .sort((first, second) => first.i.localeCompare(second.i));
}

export function widgetLayoutSnapshot(widgets: readonly DashboardRuntimeWidget[]): RuntimeLayoutSnapshot {
  return normalizeLayoutSnapshot(widgets.map((widget) => ({
    h: widget.layout.h,
    i: widget.id,
    minH: widget.layout.minH,
    minW: widget.layout.minW,
    w: widget.layout.w,
    x: widget.layout.x,
    y: widget.layout.y,
  })));
}

export function runtimePageLayoutSnapshot(
  runtime: DashboardRuntimeResponse | null,
  pageId: string,
): RuntimeLayoutSnapshot {
  return widgetLayoutSnapshot(runtime?.widgetsByPageId[pageId] ?? []);
}

export function layoutSnapshotsEqual(first: RuntimeLayoutSnapshot, second: RuntimeLayoutSnapshot) {
  if (first.length !== second.length) return false;
  return first.every((item, index) => {
    const next = second[index];
    return item.i === next.i
      && item.x === next.x
      && item.y === next.y
      && item.w === next.w
      && item.h === next.h;
  });
}

export function createDraftLayoutSaveInput(pageId: string, layout: readonly LayoutItem[]): DraftLayoutSaveInput {
  return {
    layouts: layout.map((item) => ({
      h: item.h,
      w: item.w,
      widgetId: item.i,
      x: item.x,
      y: item.y,
    })),
    pageId,
  };
}

export function applyDraftWidgetLayouts(
  runtime: DashboardRuntimeResponse | null,
  pageId: string,
  layout: readonly LayoutItem[],
): DashboardRuntimeResponse | null {
  if (!runtime) return runtime;
  const layoutByWidgetId = new Map(layout.map((item) => [item.i, item]));
  const widgets = runtime.widgetsByPageId[pageId] ?? [];

  return {
    ...runtime,
    widgetsByPageId: {
      ...runtime.widgetsByPageId,
      [pageId]: widgets.map((widget) => {
        const nextLayout = layoutByWidgetId.get(widget.id);
        if (!nextLayout) return widget;
        return {
          ...widget,
          layout: {
            ...widget.layout,
            h: nextLayout.h,
            minH: widget.layout.minH,
            minW: widget.layout.minW,
            w: nextLayout.w,
            x: nextLayout.x,
            y: nextLayout.y,
          },
        };
      }),
    },
  };
}

export function restoreDraftWidgetLayouts(
  runtime: DashboardRuntimeResponse | null,
  pageId: string,
  savedLayout: RuntimeLayoutSnapshot,
): DashboardRuntimeResponse | null {
  if (!runtime) return runtime;
  const layoutByWidgetId = new Map(savedLayout.map((item) => [item.i, item]));
  const widgets = runtime.widgetsByPageId[pageId] ?? [];

  return {
    ...runtime,
    widgetsByPageId: {
      ...runtime.widgetsByPageId,
      [pageId]: widgets.map((widget) => {
        const previousLayout = layoutByWidgetId.get(widget.id);
        if (!previousLayout) return widget;
        return {
          ...widget,
          layout: {
            ...widget.layout,
            h: previousLayout.h,
            minH: previousLayout.minH,
            minW: previousLayout.minW,
            w: previousLayout.w,
            x: previousLayout.x,
            y: previousLayout.y,
          },
        };
      }),
    },
  };
}

export async function persistDraftLayout(
  input: DraftLayoutSaveInput,
  save: (nextInput: DraftLayoutSaveInput) => Promise<unknown>,
  onSaved?: () => void,
): Promise<DraftLayoutSaveResult> {
  try {
    await save(input);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save widget layout.",
      status: "failed",
    };
  }

  onSaved?.();
  return { status: "saved" };
}
