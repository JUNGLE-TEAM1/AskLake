import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { TagList } from "@/components/ui/tag-list";
import { formatDashboardDateLabel, splitDashboardTags } from "../dashboardListUtils";
import { dashboardStatusMeta } from "../../../utils/statusMeta";
import type { SavedDashboardCard } from "../../../types";

export function DashboardTable({
  dashboards,
  deletingDashboardId,
  hasActiveFilters,
  onOpenDetail,
  onRequestDelete,
}: {
  dashboards: SavedDashboardCard[];
  deletingDashboardId: string | null;
  hasActiveFilters: boolean;
  onOpenDetail: (dashboard: SavedDashboardCard) => void;
  onRequestDelete: (dashboard: SavedDashboardCard) => void;
}) {
  const columns = useMemo<ColumnDef<SavedDashboardCard>[]>(
    () => [
      {
        accessorKey: "name",
        cell: ({ row }) => {
          const dashboard = row.original;
          return (
            <>
              <Button
                className="dashboard-row-link"
                type="button"
                variant="link"
                onClick={() => onOpenDetail(dashboard)}
              >
                {dashboard.name}
              </Button>
              <TagList className="dashboard-row-tags" density="compact">
                {splitDashboardTags(dashboard.tags).map((tag, tagIndex) => (
                  <Chip className="dashboard-row-tag" key={`${dashboard.id}-${tag}-${tagIndex}`} size="sm" tone="secondary">{tag}</Chip>
                ))}
                <StatusBadge className="dashboard-row-tag" size="sm" tone={dashboard.status === "published" ? "success" : "warning"}>
                  {dashboardStatusMeta[dashboard.status].label}
                </StatusBadge>
              </TagList>
            </>
          );
        },
        header: "이름",
        meta: {
          widthClassName: "w-[34%]",
        } as DataTableColumnMeta,
      },
      {
        accessorKey: "owner",
        header: "소유자",
        meta: {
          widthClassName: "w-[18%]",
        } as DataTableColumnMeta,
      },
      {
        accessorKey: "updated",
        header: "마지막 수정",
        meta: {
          widthClassName: "w-[16%]",
        } as DataTableColumnMeta,
      },
      {
        accessorFn: (dashboard) => formatDashboardDateLabel(dashboard.createdAtValue ?? dashboard.createdAt),
        header: "생성 일시",
        id: "createdAt",
        meta: {
          widthClassName: "w-[24%]",
        } as DataTableColumnMeta,
      },
    ],
    [onOpenDetail],
  );

  return (
    <DataTable
      className="dashboard-table-scroll"
      columns={columns}
      data={dashboards}
      emptyState={{
        description: hasActiveFilters ? "검색어나 필터 조건을 변경해 보세요." : "새 대시보드를 생성해 분석 화면을 구성해 보세요.",
        title: hasActiveFilters ? "검색 조건에 맞는 대시보드가 없습니다." : "아직 대시보드가 없습니다.",
      }}
      getRowId={(dashboard) => dashboard.id}
      tableClassName="schema-table dashboard-list-data-table"
      viewportClassName="dashboard-table-viewport"
      renderRowActions={(row) => (
        <Button
          aria-label={`${row.original.name} 삭제`}
          className="dashboard-row-delete-button"
          disabled={deletingDashboardId === row.original.id}
          title="대시보드 삭제"
          type="button"
          variant="destructive"
          size="icon"
          onClick={() => onRequestDelete(row.original)}
        >
          <Trash2 />
        </Button>
      )}
      rowActionsClassName="dashboard-table-action-cell"
      rowActionsHeader={<span className="sr-only">삭제</span>}
    />
  );
}
