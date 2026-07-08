import { Button } from "@/components/ui/button";

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
      <Button type="button" disabled={currentPage === 1} onClick={onPrevious} size="sm" variant="outline">이전</Button>
      <span>{currentPage}</span>
      <Button type="button" disabled={currentPage === totalPages} onClick={onNext} size="sm" variant="outline">다음</Button>
    </div>
  );
}
