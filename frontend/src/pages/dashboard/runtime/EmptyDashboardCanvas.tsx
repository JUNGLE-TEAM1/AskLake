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
  const fallbackTitle = editable ? "빈 대시보드 페이지" : "게시된 위젯이 없습니다";
  const fallbackDescription = editable
    ? "위젯을 이곳으로 끌어오거나 추가 버튼으로 시작하세요."
    : "초안 편집에서 페이지와 위젯을 구성한 뒤 게시하세요.";

  return (
    <div className="asklake-dashboard-empty-canvas__inner">
      <strong>{title ?? fallbackTitle}</strong>
      <span>{description ?? fallbackDescription}</span>
      {action}
    </div>
  );
}
