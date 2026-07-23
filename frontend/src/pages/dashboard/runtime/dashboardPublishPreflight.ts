import type { DashboardRuntimeResponse } from "../../../types";
import {
  hasAnyLayoutCollision,
  hasLayoutOutOfBounds,
  toCollisionLayout,
} from "./dashboardLayoutUtils.ts";

export type DashboardPublishPreflightIssue = {
  message: string;
  pageId: string;
  pageTitle: string;
  widgetId?: string;
  widgetTitle?: string;
};

export function dashboardPublishPreflight(runtime: DashboardRuntimeResponse | null): DashboardPublishPreflightIssue[] {
  if (!runtime) return [];

  return runtime.pages.flatMap((page) => {
    const widgets = runtime.widgetsByPageId[page.id] ?? [];
    const layout = toCollisionLayout(widgets);
    const issues: DashboardPublishPreflightIssue[] = [];

    if (hasLayoutOutOfBounds(layout)) {
      issues.push({
        message: "위젯 위치 또는 크기가 12열 캔버스 범위를 벗어났습니다.",
        pageId: page.id,
        pageTitle: page.title,
      });
    }
    if (hasAnyLayoutCollision(layout)) {
      issues.push({
        message: "겹쳐 있는 위젯이 있습니다.",
        pageId: page.id,
        pageTitle: page.title,
      });
    }

    return issues;
  });
}
