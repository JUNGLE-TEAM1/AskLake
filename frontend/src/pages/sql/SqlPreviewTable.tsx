import { useMemo } from "react";
import type { ColumnDef, SortingFn } from "@tanstack/react-table";
import { Table2 } from "lucide-react";

import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { PaginationBar } from "@/components/ui/pagination-bar";
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

export function SqlPreviewTable({
  resultDraft,
  remoteNextCursor,
  remotePageIndex,
  remotePageNumber,
  remotePageSize,
  remotePending = false,
  remoteRowEnd,
  remoteRowStart,
  remoteTotalPages,
  remoteTotalRows,
  onRemoteNext,
  onRemotePrevious,
}: {
  resultDraft: SqlResultDraft;
  remoteNextCursor?: string | null;
  remotePageIndex?: number;
  remotePageNumber?: number;
  remotePageSize?: number;
  remotePending?: boolean;
  remoteRowEnd?: number;
  remoteRowStart?: number;
  remoteTotalPages?: number | null;
  remoteTotalRows?: number | null;
  onRemoteNext?: () => void;
  onRemotePrevious?: () => void;
}) {
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
  const remote = remotePageIndex !== undefined;
  const currentRemotePage = remotePageNumber ?? (remotePageIndex ?? 0) + 1;
  const resolvedRemoteTotalRows = remoteTotalRows ?? resultDraft.rowCount;
  const resolvedRemotePageSize = remotePageSize ?? SQL_RESULT_PAGE_SIZE;
  const resolvedRemoteTotalPages = remoteTotalPages
    ?? (resolvedRemoteTotalRows > 0 ? Math.ceil(resolvedRemoteTotalRows / resolvedRemotePageSize) : 1);
  const shownRows = `${remoteRowStart?.toLocaleString() ?? 0}-${remoteRowEnd?.toLocaleString() ?? data.length.toLocaleString()}행`;

  return (
    <div className="grid min-w-0 gap-3">
      <DataTable
        className="sql-preview-table-wrap"
        columns={columns}
        data={data}
        data-column-count={resultDraft.columns.length}
        emptyState={{
          description: "쿼리는 실행됐지만 반환된 row가 없습니다.",
          icon: <Table2 size={18} />,
          title: "SQL 실행 결과가 비어 있습니다.",
        }}
        enableSorting={!remote}
        pagination={remote ? false : { label: "SQL 실행 결과", pageSize: SQL_RESULT_PAGE_SIZE }}
        resetPaginationKey={`${resultDraft.runId}:${remotePageIndex ?? "local"}`}
        tableClassName="schema-table sql-preview-table"
        viewportClassName="overflow-visible"
      />
      {remote ? (
        <PaginationBar
          aria-label="SQL 실행 결과 원격 페이지"
          currentPage={currentRemotePage}
          nextDisabled={remotePending || !remoteNextCursor || !onRemoteNext}
          onNext={() => onRemoteNext?.()}
          onPrevious={() => onRemotePrevious?.()}
          previousDisabled={remotePending || !onRemotePrevious}
          rangeLabel={`${shownRows} · 전체 ${resolvedRemoteTotalRows.toLocaleString()}행`}
          totalPages={resolvedRemoteTotalPages}
        />
      ) : null}
    </div>
  );
}
