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

export function SqlPreviewTable({ resultDraft }: { resultDraft: SqlResultDraft }) {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: SQL_RESULT_PAGE_SIZE });
  useEffect(() => {
    setPagination({ pageIndex: 0, pageSize: SQL_RESULT_PAGE_SIZE });
  }, [resultDraft.runId]);

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

  return (
    <div className="sql-preview-table-wrap">
      <table className="schema-table">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {pageRows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sql-result-pagination" aria-label="SQL preview result pagination">
        <span>{pageStart}-{pageEnd} / {data.length} preview rows · page {pagination.pageIndex + 1} / {pageCount}</span>
        <div>
          <button type="button" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>이전</button>
          <button type="button" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>다음</button>
        </div>
      </div>
    </div>
  );
}
