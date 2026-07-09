import { BarChart3, Plus, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { StatusBadge, type StatusBadgeTone } from "@/components/ui/status-badge";
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
  const listStatus: { label: string; tone: StatusBadgeTone } = error || createError || deleteError
    ? { label: "오류", tone: "danger" }
    : isLoading
      ? { label: "불러오는 중", tone: "default" }
      : { label: "준비됨", tone: "success" };

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
            <Plus size={16} /> {isCreatingDashboard ? "생성 중..." : "새 대시보드 생성"}
          </Button>
        )}
        className="dashboard-page-header"
        description="게시된 대시보드와 초안 상태를 확인하고 새 대시보드를 생성합니다."
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
            description="대시보드 이름, 소유자, 수정 이력을 확인하고 상세 화면으로 이동합니다."
            icon={<Table2 size={16} />}
            meta={(
              <>
                <Badge size="sm">{pageStart}-{pageEnd}</Badge>
                <StatusBadge size="sm" tone={listStatus.tone}>{listStatus.label}</StatusBadge>
              </>
            )}
            title="대시보드 목록"
          />
          <div className="dashboard-table-list-body">
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
