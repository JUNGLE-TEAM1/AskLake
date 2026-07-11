import { PaginationBar } from "@/components/ui/pagination-bar";

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
    <PaginationBar
      className="dashboard-pagination"
      currentPage={currentPage}
      onNext={onNext}
      onPrevious={onPrevious}
      pageLabel={currentPage}
      totalPages={totalPages}
    />
  );
}
