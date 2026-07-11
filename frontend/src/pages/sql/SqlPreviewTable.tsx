import { useMemo } from "react";
import type { ColumnDef, SortingFn } from "@tanstack/react-table";
import { Table2 } from "lucide-react";

import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import type { SqlResultDraft } from "../../types";
import { SQL_RESULT_PAGE_SIZE } from "./sqlLogic";

type SqlPreviewRow = {
  cells: string[];
};

type SqlPreviewCellKind = "date" | "number" | "text";

function getCellKind(value: string): SqlPreviewCellKind {
  if (/^-?\d+(?:\.\d+)?$/.test(value.replace(/,/g, ""))) return "number";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  return "text";
}

function getColumnKind(rows: string[][], index: number): SqlPreviewCellKind {
  const values = rows.map((row) => row[index] ?? "").filter((value) => value.trim().length > 0);
  if (values.length === 0) return "text";
  if (values.every((value) => getCellKind(value) === "number")) return "number";
  if (values.every((value) => getCellKind(value) === "date")) return "date";
  return "text";
}

function toComparableValue(value: string, kind: SqlPreviewCellKind) {
  if (kind === "number") {
    const numberValue = Number(value.replace(/,/g, ""));
    return Number.isNaN(numberValue) ? 0 : numberValue;
  }
  if (kind === "date") {
    const dateValue = new Date(value).getTime();
    return Number.isNaN(dateValue) ? 0 : dateValue;
  }
  return value.toLocaleLowerCase();
}

function buildSqlSortingFn(kind: SqlPreviewCellKind): SortingFn<SqlPreviewRow> {
  return (rowA, rowB, columnId) => {
    const left = String(rowA.getValue(columnId) ?? "");
    const right = String(rowB.getValue(columnId) ?? "");
    const leftValue = toComparableValue(left, kind);
    const rightValue = toComparableValue(right, kind);

    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
    }
    return String(leftValue).localeCompare(String(rightValue));
  };
}

export function SqlPreviewTable({ resultDraft }: { resultDraft: SqlResultDraft }) {
  const columns = useMemo<ColumnDef<SqlPreviewRow>[]>(
    () => resultDraft.columns.map((column, index) => {
      const columnKind = getColumnKind(resultDraft.rows, index);
      const meta: DataTableColumnMeta = {
        align: columnKind === "number" ? "right" : "left",
        cellClassName: columnKind === "number" || columnKind === "date" ? "tabular-nums" : undefined,
      };

      return {
        accessorFn: (row) => row.cells[index] ?? "",
        cell: (info) => {
          const value = String(info.getValue() ?? "");
          return <span className="block truncate" title={value}>{value}</span>;
        },
        header: () => <span className="block truncate" title={column}>{column}</span>,
        id: `${index}:${column}`,
        meta,
        sortingFn: buildSqlSortingFn(columnKind),
      };
    }),
    [resultDraft.columns, resultDraft.rows],
  );
  const data = useMemo(
    () => resultDraft.rows.map((row) => ({ cells: row.slice(0, resultDraft.columns.length) })),
    [resultDraft.columns.length, resultDraft.rows],
  );

  return (
    <DataTable
      className="sql-preview-table-wrap"
      columns={columns}
      data={data}
      data-column-count={resultDraft.columns.length}
      emptyState={{
        description: "쿼리는 실행됐지만 반환된 row가 없습니다.",
        icon: <Table2 size={18} />,
        title: "SQL preview 결과가 비어 있습니다.",
      }}
      pagination={{ label: "SQL preview", pageSize: SQL_RESULT_PAGE_SIZE }}
      resetPaginationKey={resultDraft.runId}
      tableClassName="schema-table sql-preview-table"
      viewportClassName="overflow-visible"
    />
  );
}
