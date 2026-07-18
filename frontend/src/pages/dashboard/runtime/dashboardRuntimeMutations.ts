import type {
  DashboardRuntimePage,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
} from "../../../types";

export function appendRuntimePage(
  runtime: DashboardRuntimeResponse,
  page: DashboardRuntimePage,
): DashboardRuntimeResponse {
  return {
    ...runtime,
    pages: [...runtime.pages.filter((currentPage) => currentPage.id !== page.id), page]
      .sort((left, right) => left.orderIndex - right.orderIndex),
    widgetsByPageId: {
      ...runtime.widgetsByPageId,
      [page.id]: runtime.widgetsByPageId[page.id] ?? [],
    },
  };
}

export function removeRuntimePage(
  runtime: DashboardRuntimeResponse,
  pageId: string,
): DashboardRuntimeResponse {
  const { [pageId]: _removedWidgets, ...remainingWidgetsByPageId } = runtime.widgetsByPageId;
  return {
    ...runtime,
    pages: runtime.pages.filter((page) => page.id !== pageId),
    widgetsByPageId: remainingWidgetsByPageId,
  };
}

export function removeRuntimeWidget(
  runtime: DashboardRuntimeResponse,
  widgetId: string,
): DashboardRuntimeResponse {
  const targetPageId = Object.entries(runtime.widgetsByPageId)
    .find(([, widgets]) => widgets.some((widget) => widget.id === widgetId))?.[0];
  if (!targetPageId) return runtime;

  return {
    ...runtime,
    widgetsByPageId: {
      ...runtime.widgetsByPageId,
      [targetPageId]: runtime.widgetsByPageId[targetPageId]
        .filter((widget) => widget.id !== widgetId),
    },
  };
}

export function upsertRuntimeWidget(
  runtime: DashboardRuntimeResponse,
  widget: DashboardRuntimeWidget,
): DashboardRuntimeResponse {
  const currentWidgets = runtime.widgetsByPageId[widget.pageId] ?? [];
  const existingIndex = currentWidgets.findIndex((currentWidget) => currentWidget.id === widget.id);
  const nextWidgets = existingIndex >= 0
    ? currentWidgets.map((currentWidget) => (currentWidget.id === widget.id ? widget : currentWidget))
    : [...currentWidgets, widget];

  return {
    ...runtime,
    widgetsByPageId: {
      ...runtime.widgetsByPageId,
      [widget.pageId]: nextWidgets,
    },
  };
}
