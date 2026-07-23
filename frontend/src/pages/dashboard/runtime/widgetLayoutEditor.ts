import type { DashboardRuntimeWidget, DashboardWidgetLayout } from "../../../types";

const desktopColumns = 12;

export type LayoutDraft = Record<"h" | "w" | "x" | "y", string>;

export function draftFromLayout(layout: DashboardWidgetLayout): LayoutDraft {
  return {
    h: String(layout.h),
    w: String(layout.w),
    x: String(layout.x),
    y: String(layout.y),
  };
}

function integerValue(value: string) {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

export function layoutFromDraft(widget: DashboardRuntimeWidget, draft: LayoutDraft): DashboardWidgetLayout | string {
  const x = integerValue(draft.x);
  const y = integerValue(draft.y);
  const w = integerValue(draft.w);
  const h = integerValue(draft.h);
  const minW = widget.layout.minW ?? 1;
  const minH = widget.layout.minH ?? 1;

  if (x === null || y === null || w === null || h === null) return "좌표와 크기는 0 이상의 정수로 입력해 주세요.";
  if (w < minW || h < minH) return `이 위젯의 최소 크기는 ${minW}열 × ${minH}행입니다.`;
  if (w > desktopColumns) return `너비는 최대 ${desktopColumns}열까지 입력할 수 있습니다.`;
  if (x + w > desktopColumns) return "X 좌표와 너비의 합이 12열을 넘을 수 없습니다.";

  return {
    ...widget.layout,
    h,
    minH,
    minW,
    w,
    x,
    y,
  };
}
