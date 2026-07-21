import type { DashboardRuntimeWidget } from "../../../types";

export function stableDashboardAssistantJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDashboardAssistantJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableDashboardAssistantJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function dashboardAssistantWidgetContextSignature(
  widgets: readonly DashboardRuntimeWidget[],
) {
  return stableDashboardAssistantJson(widgets.map((widget) => ({
    config: widget.config,
    datasetId: widget.datasetId ?? null,
    id: widget.id,
    title: widget.title ?? null,
    type: widget.type,
  })));
}
