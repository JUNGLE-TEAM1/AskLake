import type { DashboardRuntimeWidget, DashboardWidgetLayout } from "../../../types";

export type CollisionLayoutItem = {
  h: number;
  i: string;
  w: number;
  x: number;
  y: number;
};

export function isLayoutColliding(a: CollisionLayoutItem, b: CollisionLayoutItem) {
  if (a.i === b.i) return false;

  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function hasAnyLayoutCollision(layout: readonly CollisionLayoutItem[]) {
  for (let i = 0; i < layout.length; i += 1) {
    for (let j = i + 1; j < layout.length; j += 1) {
      if (isLayoutColliding(layout[i], layout[j])) return true;
    }
  }

  return false;
}

export function toCollisionLayout(widgets: readonly DashboardRuntimeWidget[]) {
  return widgets.map((widget) => ({
    h: widget.layout.h,
    i: widget.id,
    w: widget.layout.w,
    x: widget.layout.x,
    y: widget.layout.y,
  }));
}

export function findNextAvailableLayout(
  existingLayout: readonly CollisionLayoutItem[],
  size: DashboardWidgetLayout,
  cols = 12,
): DashboardWidgetLayout {
  const w = Math.min(cols, Math.max(1, Math.round(size.w)));
  const h = Math.max(1, Math.round(size.h));
  const y = existingLayout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
  const x = Math.min(Math.max(0, Math.round(size.x)), Math.max(0, cols - w));
  return { ...size, h, w, x, y };
}
