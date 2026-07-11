import { useEffect, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import type { SqlResultDraft } from "../../types";
import { SQL_RESULT_PAGE_SIZE } from "./sqlLogic";

type SqlPreviewRow = {
  cells: string[];
};

function getCellKind(value: string) {
  if (/^-?\d+(?:\.\d+)?$/.test(value.replace(/,/g, ""))) return "number";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  return "text";
}

export function SqlPreviewTable({
  resultDraft,
  remoteNextCursor,
  remotePageIndex,
  remotePending = false,
  onRemoteNext,
  onRemotePrevious,
}: {
  resultDraft: SqlResultDraft;
  remoteNextCursor?: string | null;
  remotePageIndex?: number;
  remotePending?: boolean;
  onRemoteNext?: () => void;
  onRemotePrevious?: () => void;
}) {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: SQL_RESULT_PAGE_SIZE });
  useEffect(() => {
    setPagination({
      pageIndex: 0,
      pageSize: remotePageIndex === undefined ? SQL_RESULT_PAGE_SIZE : Math.max(1, resultDraft.rows.length),
    });
  }, [remotePageIndex, resultDraft.rows.length, resultDraft.runId]);

  const columns = useMemo<ColumnDef<SqlPreviewRow>[]>(
    () => resultDraft.columns.map((column, index) => ({
      accessorFn: (row) => row.cells[index] ?? "",
      cell: (info) => info.getValue<string>(),
      header: column,
      id: `${index}:${column}`,
    })),
    [resultDraft.columns],
  );
  const data = useMemo(
    () => resultDraft.rows.map((row) => ({ cells: row.slice(0, resultDraft.columns.length) })),
    [resultDraft.columns.length, resultDraft.rows],
  );
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: { pagination },
  });
  const pageRows = table.getRowModel().rows;
  const pageStart = data.length === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = data.length === 0 ? 0 : Math.min(data.length, pageStart + pageRows.length - 1);
  const pageCount = Math.max(table.getPageCount(), 1);
  const canGoPrevious = table.getCanPreviousPage() || Boolean(onRemotePrevious);
  const canGoNext = table.getCanNextPage() || Boolean(remoteNextCursor && onRemoteNext);

  const goPrevious = () => {
    if (table.getCanPreviousPage()) {
      table.previousPage();
      return;
    }
    onRemotePrevious?.();
  };

  const goNext = () => {
    if (table.getCanNextPage()) {
      table.nextPage();
      return;
    }
    onRemoteNext?.();
  };

  return (
    <div className="sql-preview-table-wrap" data-column-count={resultDraft.columns.length}>
      <table className="schema-table sql-preview-table">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} title={String(header.column.columnDef.header ?? "")}>
                  <span>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</span>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {pageRows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td data-value-kind={getCellKind(String(cell.getValue() ?? ""))} key={cell.id} title={String(cell.getValue() ?? "")}>
                  <span>{flexRender(cell.column.columnDef.cell, cell.getContext())}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sql-result-pagination" aria-label="SQL 실행 결과 페이지">
        <span>{pageStart}-{pageEnd} / {data.length}행 · {remotePageIndex === undefined ? pagination.pageIndex + 1 : remotePageIndex + 1} / {remotePageIndex === undefined ? pageCount : "?"}쪽</span>
        <div>
          <button type="button" disabled={remotePending || !canGoPrevious} onClick={goPrevious}>이전</button>
          <button type="button" disabled={remotePending || !canGoNext} onClick={goNext}>다음</button>
        </div>
      </div>
    </div>
  );
}
