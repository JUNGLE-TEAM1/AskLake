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

  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x <= cols - w; x += 1) {
      const candidate = { h, i: "__candidate__", w, x, y };
      if (!existingLayout.some((item) => isLayoutColliding(candidate, item))) {
        return { ...size, h, w, x, y };
      }
    }
  }

  const y = existingLayout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
  return { ...size, h, w, x: 0, y };
}
