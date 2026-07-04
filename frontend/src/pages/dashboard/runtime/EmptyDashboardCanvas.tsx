export function EmptyDashboardCanvas({ editable }: { editable: boolean }) {
  return (
    <div className="asklake-dashboard-empty-canvas__inner">
      <strong>{editable ? "빈 대시보드 페이지" : "게시된 위젯이 없습니다"}</strong>
      <span>
        {editable
          ? "위젯을 이곳으로 끌어오거나 추가 버튼으로 시작하세요."
          : "초안 편집에서 페이지와 위젯을 구성한 뒤 게시하세요."}
      </span>
    </div>
  );
}
