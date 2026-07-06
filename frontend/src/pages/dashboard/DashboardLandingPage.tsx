import { Plus } from "lucide-react";
import { DashboardDeleteConfirmDialog } from "./components/DashboardDeleteConfirmDialog";
import { DashboardListToolbar } from "./components/DashboardListToolbar";
import { DashboardPagination } from "./components/DashboardPagination";
import { DashboardTable } from "./components/DashboardTable";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";
import type { SavedDashboardCard } from "../../types";

export function DashboardLandingPage({
  currentPage,
  createError,
  dashboardCount,
  deleteError,
  deleteTarget,
  deletingDashboardId,
  dashboards,
  error,
  isLoading,
  isCreatingDashboard,
  onClearTags,
  onCreateDashboard,
  onCancelDelete,
  onConfirmDelete,
  onNextPage,
  onOpenDashboard,
  onPreviousPage,
  onRequestDelete,
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
  createError: string | null;
  dashboardCount: number;
  deleteError: string | null;
  deleteTarget: SavedDashboardCard | null;
  deletingDashboardId: string | null;
  dashboards: SavedDashboardCard[];
  error: string | null;
  isLoading: boolean;
  isCreatingDashboard: boolean;
  onClearTags: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onCreateDashboard: () => void;
  onNextPage: () => void;
  onOpenDashboard: (dashboard: SavedDashboardCard) => void;
  onPreviousPage: () => void;
  onRequestDelete: (dashboard: SavedDashboardCard) => void;
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
          <button
            className="primary-button dashboard-create-button"
            disabled={isCreatingDashboard}
            type="button"
            onClick={onCreateDashboard}
          >
            <Plus size={24} /> {isCreatingDashboard ? "생성 중..." : "새 대시보드 생성"}
          </button>
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
        {isLoading && <div className="dashboard-list-count">Postgres에서 대시보드를 불러오는 중입니다.</div>}
        {error && <div className="dashboard-list-count">Dashboard API error: {error}</div>}
        {createError && <div className="dashboard-list-count">대시보드 생성 오류: {createError}</div>}
        <DashboardTable
          dashboards={dashboards}
          deletingDashboardId={deletingDashboardId}
          onOpenDetail={onOpenDashboard}
          onRequestDelete={onRequestDelete}
        />
        <DashboardPagination currentPage={currentPage} totalPages={totalPages} onPrevious={onPreviousPage} onNext={onNextPage} />
      </section>
      {deleteTarget && (
        <DashboardDeleteConfirmDialog
          dashboard={deleteTarget}
          error={deleteError}
          isDeleting={deletingDashboardId === deleteTarget.id}
          onCancel={onCancelDelete}
          onConfirm={onConfirmDelete}
        />
      )}
    </div>
  );
}
