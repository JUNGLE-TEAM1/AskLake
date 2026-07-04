import { Plus } from "lucide-react";
import type { SavedDashboardCard } from "./DashboardParts";
import { DashboardListToolbar } from "./components/DashboardListToolbar";
import { DashboardPagination } from "./components/DashboardPagination";
import { DashboardTable } from "./components/DashboardTable";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";

export function DashboardLandingPage({
  currentPage,
  dashboardCount,
  dashboards,
  onClearTags,
  onCreateDashboard,
  onNextPage,
  onOpenDashboard,
  onPreviousPage,
  onSearchQueryChange,
  onSelectOwner,
  onSelectSort,
  onToggleControl,
  onToggleTag,
  openControl,
  ownerFilter,
  owners,
  pageEnd,
  pageStart,
  searchQuery,
  selectedTags,
  sortOption,
  tags,
  totalPages,
}: {
  currentPage: number;
  dashboardCount: number;
  dashboards: SavedDashboardCard[];
  onClearTags: () => void;
  onCreateDashboard: () => void;
  onNextPage: () => void;
  onOpenDashboard: (name: string) => void;
  onPreviousPage: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectOwner: (owner: string) => void;
  onSelectSort: (sortOption: DashboardSortOption) => void;
  onToggleControl: (control: DashboardListControl) => void;
  onToggleTag: (tag: string) => void;
  openControl: DashboardListControl | null;
  ownerFilter: string;
  owners: string[];
  pageEnd: number;
  pageStart: number;
  searchQuery: string;
  selectedTags: string[];
  sortOption: DashboardSortOption;
  tags: string[];
  totalPages: number;
}) {
  return (
    <div className="dashboard-page dashboard-list-page">
      <header className="dashboard-header">
        <div>
          <h1>대시보드</h1>
        </div>
        <div className="dashboard-header-actions">
          <button className="primary-button dashboard-create-button" type="button" onClick={onCreateDashboard}><Plus size={24} /> 새 대시보드 생성</button>
        </div>
      </header>

      <DashboardListToolbar
        onClearTags={onClearTags}
        onSearchQueryChange={onSearchQueryChange}
        onSelectOwner={onSelectOwner}
        onSelectSort={onSelectSort}
        onToggleControl={onToggleControl}
        onToggleTag={onToggleTag}
        openControl={openControl}
        ownerFilter={ownerFilter}
        owners={owners}
        searchQuery={searchQuery}
        selectedTags={selectedTags}
        sortOption={sortOption}
        tags={tags}
      />

      <section className="dashboard-table-list">
        <div className="dashboard-list-count">전체 {dashboardCount}개 중 {pageStart}-{pageEnd}개 표시</div>
        <DashboardTable dashboards={dashboards} onOpenDetail={onOpenDashboard} />
        <DashboardPagination currentPage={currentPage} totalPages={totalPages} onPrevious={onPreviousPage} onNext={onNextPage} />
      </section>
    </div>
  );
}
