export function DashboardPagination({
  currentPage,
  onNext,
  onPrevious,
  totalPages,
}: {
  currentPage: number;
  onNext: () => void;
  onPrevious: () => void;
  totalPages: number;
}) {
  return (
    <div className="dashboard-pagination">
      <button type="button" disabled={currentPage === 1} onClick={onPrevious}>이전</button>
      <span>{currentPage}</span>
      <button type="button" disabled={currentPage === totalPages} onClick={onNext}>다음</button>
    </div>
  );
}
