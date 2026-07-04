import type React from "react";

export function EmptyDashboardCanvas({
  action,
  description,
  editable,
  title,
}: {
  action?: React.ReactNode;
  description?: string;
  editable: boolean;
  title?: string;
}) {
  const fallbackTitle = editable ? "빈 대시보드 페이지" : "위젯을 추가해 주세요";
  const fallbackDescription = editable
    ? "위젯을 이곳으로 끌어오거나 추가 버튼으로 시작하세요."
    : "왼쪽 사이드바에서 데이터셋을 선택 후, 오른쪽 사이드바에서 위젯을 생성할 수 있습니다";

  return (
    <div className="asklake-dashboard-empty-canvas__inner">
      <strong>{title ?? fallbackTitle}</strong>
      <span>{description ?? fallbackDescription}</span>
      {action}
    </div>
  );
}
