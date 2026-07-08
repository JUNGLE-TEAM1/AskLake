import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { formatDashboardDateLabel, splitDashboardTags } from "../dashboardListUtils";
import { dashboardStatusMeta } from "../../../utils/statusMeta";
import type { SavedDashboardCard } from "../../../types";

export function DashboardTable({
  dashboards,
  deletingDashboardId,
  onOpenDetail,
  onRequestDelete,
}: {
  dashboards: SavedDashboardCard[];
  deletingDashboardId: string | null;
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
              <span className="dashboard-row-tags">
                {[...splitDashboardTags(dashboard.tags), dashboardStatusMeta[dashboard.status].label].map((tag, tagIndex) => (
                  <span className="dashboard-row-tag" key={`${dashboard.id}-${tag}-${tagIndex}`}>{tag}</span>
                ))}
              </span>
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
        description: "검색 조건에 맞는 대시보드가 없습니다.",
        title: "대시보드가 없습니다.",
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
          <Trash2 size={18} />
        </Button>
      )}
      rowActionsClassName="dashboard-table-action-cell"
      rowActionsHeader={<span className="sr-only">삭제</span>}
    />
  );
}
