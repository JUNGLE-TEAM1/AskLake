import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Table2 } from "lucide-react";

import { DataTable } from "@/components/ui/data-table";

type SourcePreviewRow = {
  id: string;
  values: string[];
};

type SourcePreviewDataTableProps = {
  columnLabels: string[];
  rows: string[][];
};

export function SourcePreviewDataTable({ columnLabels, rows }: SourcePreviewDataTableProps) {
  const data = useMemo<SourcePreviewRow[]>(
    () => rows.map((values, index) => ({ id: `source-preview-${index}`, values })),
    [rows],
  );
  const columns = useMemo<ColumnDef<SourcePreviewRow>[]>(
    () => columnLabels.map((label, index) => ({
      accessorFn: (row) => row.values[index] ?? "-",
      cell: (info) => <span className="source-preview-cell" title={String(info.getValue() ?? "-")}>{String(info.getValue() ?? "-")}</span>,
      header: label,
      id: `source-preview-column-${index}`,
      meta: { headerClassName: "bg-blue-50/70 text-slate-600", widthClassName: "min-w-36" },
    })),
    [columnLabels],
  );

  return (
    <DataTable
      cellClassName="text-sm font-medium"
      columns={columns}
      data={data}
      emptyState={{
        description: "왼쪽 탐색 영역에서 대상을 선택하세요.",
        icon: <Table2 />,
        title: "표시할 제한 샘플이 없습니다.",
      }}
      enableSorting={false}
      getRowId={(row) => row.id}
      pagination={false}
      tableClassName={`source-preview-data-table ${columnLabels.length === 0 ? "is-empty" : ""}`}
      viewportClassName="source-preview-data-table-viewport rounded-none border-0"
    />
  );
}
