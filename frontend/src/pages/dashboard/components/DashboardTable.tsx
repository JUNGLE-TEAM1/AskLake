import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import {
  DataTableCellPrimary,
  DataTableCellSecondary,
  DataTableStackedCell,
} from "@/components/ui/data-table-stacked-cell";
import { formatDashboardDateLabel, localizeDashboardName, localizeDashboardOwner, localizeDashboardTags } from "../dashboardListUtils";
import type { SavedDashboardCard } from "../../../types";
import { permissionDeniedMessage } from "../../../utils/permissions";

function getOwnerInitials(owner: string) {
  const words = owner.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

function getOwnerInitials(owner: string) {
  const words = owner.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

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
          const tags = localizeDashboardTags(dashboard.tags);
          const dashboardName = localizeDashboardName(dashboard);
          return (
            <Button
              className="min-h-[72px] w-full justify-start rounded-none px-0 py-0 text-left hover:bg-transparent"
              type="button"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onOpenDetail(dashboard);
              }}
            >
              <DataTableStackedCell className="w-full gap-1.5">
                <span className="truncate text-xl font-semibold leading-7 text-slate-950">
                  {dashboardName}
                </span>
                <DataTableCellSecondary className="text-base" title={tags.join(" · ")}>
                  {tags.length ? tags.join(" · ") : "태그 없음"}
                </DataTableCellSecondary>
              </DataTableStackedCell>
            </Button>
          );
        },
        header: "대시보드",
        meta: {
          cellClassName: "pl-6",
          headerClassName: "pl-6 text-lg",
          widthClassName: "w-[320px]",
        } satisfies DataTableColumnMeta,
      },
      {
        accessorFn: (dashboard) => dashboard.updatedAtValue ?? dashboard.updated,
        cell: ({ row }) => (
          <DataTableCellPrimary className="text-lg">
            {formatDashboardDateLabel(row.original.updatedAtValue ?? row.original.updated)}
          </DataTableCellPrimary>
        ),
        header: "마지막 수정",
        id: "updatedAt",
        meta: {
          headerClassName: "text-lg",
          widthClassName: "w-[220px]",
        } satisfies DataTableColumnMeta,
      },
      {
        accessorFn: (dashboard) => formatDashboardDateLabel(dashboard.createdAtValue ?? dashboard.createdAt),
        cell: ({ row }) => (
          <DataTableCellPrimary className="text-lg">
            {formatDashboardDateLabel(row.original.createdAtValue ?? row.original.createdAt)}
          </DataTableCellPrimary>
        ),
        header: "생성 일시",
        id: "createdAt",
        meta: {
          headerClassName: "text-lg",
          widthClassName: "w-[220px]",
        } satisfies DataTableColumnMeta,
      },
      {
        accessorKey: "owner",
        cell: ({ row }) => {
          const dashboard = row.original;
          const owner = localizeDashboardOwner(dashboard.owner);
          return (
            <div className="flex min-w-0 items-center gap-2.5 text-left">
              <Avatar size="lg">
                <AvatarFallback className="bg-slate-100 font-semibold text-slate-700 ring-1 ring-slate-200">
                  {getOwnerInitials(owner)}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 gap-1">
                <span className="truncate text-lg font-semibold text-slate-800" title={owner}>{owner}</span>
                <span className="truncate text-base font-medium text-slate-500" title={dashboard.updated}>
                  최근 수정 {dashboard.updated}
                </span>
              </div>
            </div>
          );
        },
        header: "소유자",
        meta: {
          headerClassName: "text-lg",
          widthClassName: "w-[220px]",
        } satisfies DataTableColumnMeta,
      },
    ],
    [onOpenDetail],
  );

  return (
    <DataTable
      bodyRowClassName="min-h-[96px]"
      cellClassName="py-5"
      className="dashboard-table-scroll gap-0"
      columns={columns}
      data={dashboards}
      emptyState={{
        description: hasActiveFilters ? "검색어나 필터 조건을 변경해 보세요." : "새 대시보드를 생성해 분석 화면을 구성해 보세요.",
        title: hasActiveFilters ? "검색 조건에 맞는 대시보드가 없습니다." : "아직 대시보드가 없습니다.",
      }}
      getRowId={(dashboard) => dashboard.id}
      headerRowClassName="h-[68px] bg-white"
      onRowClick={(row) => onOpenDetail(row.original)}
      tableClassName="dashboard-list-data-table"
      viewportClassName="dashboard-table-viewport"
      renderRowActions={(row) => (
        <Button
          aria-label={`${localizeDashboardName(row.original)} 삭제`}
          className="text-slate-500 hover:text-red-600"
          disabled={deletingDashboardId === row.original.id}
          title="대시보드 삭제"
          type="button"
          variant="ghost"
          size="icon"
          onClick={(event) => {
            event.stopPropagation();
            onRequestDelete(row.original);
          }}
        >
          <Trash2 />
        </Button>
      )}
      rowActionsClassName="dashboard-table-action-cell"
      rowActionsHeader={<span className="sr-only">삭제</span>}
    />
  );
}
