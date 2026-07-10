import { AlertCircle, BarChart3, Plus, Table2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardDeleteConfirmDialog } from "./components/DashboardDeleteConfirmDialog";
import { DashboardListToolbar } from "./components/DashboardListToolbar";
import { DashboardPagination } from "./components/DashboardPagination";
import { DashboardTable } from "./components/DashboardTable";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";
import type { SavedDashboardCard } from "../../types";

function DashboardListSkeleton() {
  return (
    <div aria-label="대시보드 목록을 불러오는 중" className="grid gap-3" role="status">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(100px,1fr)_minmax(120px,1fr)_40px] items-center gap-4 rounded-lg border border-slate-200 p-3" key={index}>
          <div className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-8" />
        </div>
      ))}
    </div>
  );
}

export function DashboardLandingPage({
  currentPage,
  createError,
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
      <PageHeader
        actions={(
          <Button
            className="primary-button dashboard-create-button"
            disabled={isCreatingDashboard}
            type="button"
            size="sm"
            variant="primary"
            onClick={onCreateDashboard}
          >
            <Plus data-icon="inline-start" /> {isCreatingDashboard ? "생성 중..." : "새 대시보드 생성"}
          </Button>
        )}
        className="dashboard-page-header"
        icon={<BarChart3 size={18} />}
        title="대시보드"
      />

      <div className="dashboard-panel-stack">
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

        <Panel className="dashboard-table-list">
          <PanelHeader
            icon={<Table2 size={16} />}
            title="대시보드 목록"
          />
          <div className="dashboard-table-list-body">
            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>대시보드 목록을 불러오지 못했습니다.</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {createError && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>대시보드를 생성하지 못했습니다.</AlertTitle>
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            {isLoading ? (
              <DashboardListSkeleton />
            ) : (
              <DashboardTable
                dashboards={dashboards}
                deletingDashboardId={deletingDashboardId}
                hasActiveFilters={Boolean(searchQuery.trim() || ownerFilter !== "all" || selectedTags.length)}
                onOpenDetail={onOpenDashboard}
                onRequestDelete={onRequestDelete}
              />
            )}
            <DashboardPagination currentPage={currentPage} totalPages={totalPages} onPrevious={onPreviousPage} onNext={onNextPage} />
          </div>
        </Panel>
      </div>
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
