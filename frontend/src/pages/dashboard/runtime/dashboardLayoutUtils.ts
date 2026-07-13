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

export function isLayoutWithinBounds(item: CollisionLayoutItem, cols = 12) {
  return item.x >= 0 && item.y >= 0 && item.w > 0 && item.h > 0 && item.x + item.w <= cols;
}

export function hasLayoutOutOfBounds(layout: readonly CollisionLayoutItem[], cols = 12) {
  return layout.some((item) => !isLayoutWithinBounds(item, cols));
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

function normalizeLayoutSize(size: DashboardWidgetLayout, cols: number) {
  const minW = Math.min(cols, Math.max(1, Math.round(size.minW ?? 1)));
  const minH = Math.max(1, Math.round(size.minH ?? 1));
  const w = Math.min(cols, Math.max(minW, Math.round(size.w)));
  const h = Math.max(minH, Math.round(size.h));
  const x = Math.min(Math.max(0, Math.round(size.x)), Math.max(0, cols - w));
  const y = Math.max(0, Math.round(size.y));

  return { ...size, h, minH, minW, w, x, y };
}

function isAvailable(candidate: CollisionLayoutItem, existingLayout: readonly CollisionLayoutItem[], cols: number) {
  return isLayoutWithinBounds(candidate, cols) && !existingLayout.some((item) => isLayoutColliding(candidate, item));
}

export function findNextAvailableLayout(
  existingLayout: readonly CollisionLayoutItem[],
  size: DashboardWidgetLayout,
  cols = 12,
): DashboardWidgetLayout {
  const normalized = normalizeLayoutSize(size, cols);
  const bottomRow = existingLayout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
  const lastCandidateRow = bottomRow + normalized.h;

  for (let y = 0; y <= lastCandidateRow; y += 1) {
    for (let x = 0; x <= cols - normalized.w; x += 1) {
      const candidate = { ...normalized, i: "__candidate__", x, y };
      if (isAvailable(candidate, existingLayout, cols)) {
        return { ...normalized, x, y };
      }
    }
  }

  return { ...normalized, x: 0, y: bottomRow };
}
