import type { Dispatch, SetStateAction } from "react";
import type { LayoutItem } from "react-grid-layout";
import { saveDraftLayouts } from "../../../services/dashboardRuntimeApi";
import type { AuditResult, DashboardRuntimeResponse } from "../../../types";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type UseDraftWidgetLayoutsParams = {
  dashboardId: string;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  selectedPageId: string | null;
  setDraftError: (message: string | null) => void;
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setRuntimeNotice: (notice: RuntimeNotice) => void;
};

export function useDraftWidgetLayouts({
  dashboardId,
  onAction,
  selectedPageId,
  setDraftError,
  setDraftRuntime,
  setRuntimeNotice,
}: UseDraftWidgetLayoutsParams) {
  const updateDraftWidgetLayouts = (layout: LayoutItem[]) => {
    if (!selectedPageId) return;

    const layoutByWidgetId = new Map(layout.map((item) => [item.i, item]));

    setDraftRuntime((currentRuntime) => {
      if (!currentRuntime) return currentRuntime;
      const widgets = currentRuntime.widgetsByPageId[selectedPageId] ?? [];
      return {
        ...currentRuntime,
        widgetsByPageId: {
          ...currentRuntime.widgetsByPageId,
          [selectedPageId]: widgets.map((widget) => {
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
    });

    void saveDraftLayouts(dashboardId, {
      layouts: layout.map((item) => ({
        h: item.h,
        w: item.w,
        widgetId: item.i,
        x: item.x,
        y: item.y,
      })),
      pageId: selectedPageId,
    }).catch((error) => {
      setDraftError(error instanceof Error ? error.message : "Failed to save widget layout.");
    });
    onAction("dashboard.layout.saved", `/api/dashboards/${dashboardId}/draft/layouts`, selectedPageId);
  };

  return { updateDraftWidgetLayouts };
}
