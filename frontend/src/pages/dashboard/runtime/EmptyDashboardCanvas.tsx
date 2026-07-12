import type React from "react";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

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
    : "편집 모드에서 데이터셋과 위젯을 추가한 뒤 게시해 주세요.";

  return (
    <Empty className="asklake-dashboard-empty-canvas__inner" size="lg" variant="plain">
      <EmptyHeader>
        <EmptyTitle>{title ?? fallbackTitle}</EmptyTitle>
        <EmptyDescription>{description ?? fallbackDescription}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyActions>{action}</EmptyActions> : null}
    </Empty>
  );
}
