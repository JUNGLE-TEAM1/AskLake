import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type DataTableColumnAlign = "left" | "center" | "right";

export type DataTableColumnMeta = {
  align?: DataTableColumnAlign;
  cellClassName?: string;
  headerClassName?: string;
  widthClassName?: string;
};

export type DataTableEmptyState = {
  action?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  title: React.ReactNode;
};

export type DataTablePaginationOptions = {
  label?: string;
  pageSize?: number;
  pageSizeOptions?: number[];
  showPageSize?: boolean;
};

export interface DataTableProps<TData, TValue>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  bodyRowClassName?: string;
  caption?: React.ReactNode;
  cellClassName?: string;
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  emptyState?: DataTableEmptyState | React.ReactNode;
  enableSorting?: boolean;
  getRowClassName?: (row: Row<TData>) => string | undefined;
  getRowId?: (originalRow: TData, index: number, parent?: Row<TData>) => string;
  headerRowClassName?: string;
  initialSorting?: SortingState;
  isLoading?: boolean;
  loadingRowCount?: number;
  pagination?: false | DataTablePaginationOptions;
  renderRowActions?: (row: Row<TData>) => React.ReactNode;
  resetPaginationKey?: React.Key;
  rowActionsClassName?: string;
  rowActionsHeader?: React.ReactNode;
  tableClassName?: string;
  viewportClassName?: string;
}

const alignClassName: Record<DataTableColumnAlign, string> = {
  center: "text-center",
  left: "text-left",
  right: "text-right",
};

function getColumnMeta<TData, TValue>(columnDef: ColumnDef<TData, TValue>) {
  return (columnDef.meta ?? {}) as DataTableColumnMeta;
}

function getSortIcon(sortState: false | "asc" | "desc") {
  if (sortState === "asc") return ArrowUp;
  if (sortState === "desc") return ArrowDown;
  return ArrowUpDown;
}

function renderEmptyState(emptyState: DataTableProps<unknown, unknown>["emptyState"]) {
  if (!emptyState) {
    return (
      <EmptyState
        description="조건에 맞는 행이 없습니다."
        size="sm"
        title="표시할 데이터가 없습니다."
        variant="plain"
      />
    );
  }

  if (React.isValidElement(emptyState)) return emptyState;
  if (typeof emptyState !== "object" || !("title" in emptyState)) return emptyState;

  const props = emptyState as DataTableEmptyState;
  return <EmptyState size="sm" variant="plain" {...props} />;
}

function getPaginationOptions(pagination: DataTableProps<unknown, unknown>["pagination"]) {
  if (!pagination) return null;
  return {
    label: pagination?.label ?? "표",
    pageSize: pagination?.pageSize ?? 25,
    pageSizeOptions: pagination?.pageSizeOptions ?? [10, 25, 50, 100],
    showPageSize: pagination?.showPageSize ?? false,
  };
}

export function DataTable<TData, TValue>({
  bodyRowClassName,
  caption,
  cellClassName,
  className,
  columns,
  data,
  emptyState,
  enableSorting = true,
  getRowClassName,
  getRowId,
  headerRowClassName,
  initialSorting = [],
  isLoading = false,
  loadingRowCount = 4,
  pagination,
  renderRowActions,
  resetPaginationKey,
  rowActionsClassName,
  rowActionsHeader,
  tableClassName,
  viewportClassName,
  ...props
}: DataTableProps<TData, TValue>) {
  const paginationOptions = getPaginationOptions(pagination);
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [paginationState, setPaginationState] = React.useState<PaginationState>({
    pageIndex: 0,
    pageSize: paginationOptions?.pageSize ?? (data.length || 1),
  });

  React.useEffect(() => {
    if (!paginationOptions) return;
    setPaginationState({
      pageIndex: 0,
      pageSize: paginationOptions.pageSize,
    });
  }, [paginationOptions?.pageSize, resetPaginationKey]);

  React.useEffect(() => {
    setPaginationState((current) => ({ ...current, pageIndex: 0 }));
  }, [data.length, sorting]);

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    setPaginationState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return next;
    });
  };

  const table = useReactTable({
    columns,
    data,
    enableSorting,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: paginationOptions ? getPaginationRowModel() : undefined,
    getRowId,
    getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
    onPaginationChange: handlePaginationChange,
    onSortingChange: setSorting,
    state: {
      pagination: paginationState,
      sorting,
    },
  });

  const rows = table.getRowModel().rows;
  const visibleColumnCount = table.getVisibleLeafColumns().length + (renderRowActions ? 1 : 0);
  const totalRows = table.getPrePaginationRowModel().rows.length;
  const pageStart = totalRows === 0 ? 0 : paginationState.pageIndex * paginationState.pageSize + 1;
  const pageEnd = totalRows === 0 ? 0 : Math.min(totalRows, pageStart + rows.length - 1);
  const pageCount = Math.max(table.getPageCount(), 1);

  return (
    <div className={cn("grid min-w-0 gap-3", className)} {...props}>
      <div className={cn("min-w-0 overflow-x-auto rounded-lg border border-slate-200 bg-white", viewportClassName)}>
        <Table className={tableClassName}>
          {caption && <TableCaption>{caption}</TableCaption>}
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow className={headerRowClassName} key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = getColumnMeta(header.column.columnDef);
                  const sortState = header.column.getIsSorted();
                  const SortIcon = getSortIcon(sortState);
                  const canSort = enableSorting && header.column.getCanSort();
                  const align = meta.align ?? "left";

                  return (
                    <TableHead
                      aria-sort={sortState === "asc" ? "ascending" : sortState === "desc" ? "descending" : undefined}
                      className={cn(
                        alignClassName[align],
                        meta.widthClassName,
                        meta.headerClassName,
                      )}
                      key={header.id}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          className={cn(
                            "inline-flex w-full min-w-0 items-center gap-1.5 rounded-md text-inherit outline-none transition-colors hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
                            align === "center" && "justify-center",
                            align === "right" && "justify-end",
                          )}
                          onClick={header.column.getToggleSortingHandler()}
                          type="button"
                        >
                          <span className="min-w-0 truncate">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          <SortIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
                {renderRowActions && (
                  <TableHead className={cn("w-0 text-right", rowActionsClassName)}>
                    {rowActionsHeader}
                  </TableHead>
                )}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: loadingRowCount }).map((_, rowIndex) => (
                <TableRow className={bodyRowClassName} key={`loading-${rowIndex}`}>
                  {table.getVisibleLeafColumns().map((column, columnIndex) => {
                    const meta = getColumnMeta(column.columnDef);
                    return (
                      <TableCell
                        className={cn(meta.widthClassName, meta.cellClassName, cellClassName)}
                        key={`loading-${rowIndex}-${column.id}`}
                      >
                        <span
                          className={cn(
                            "block h-3 animate-pulse rounded-full bg-slate-200",
                            columnIndex % 3 === 0 ? "w-3/4" : columnIndex % 3 === 1 ? "w-1/2" : "w-5/6",
                          )}
                        />
                      </TableCell>
                    );
                  })}
                  {renderRowActions && (
                    <TableCell className={cn("text-right", rowActionsClassName)}>
                      <Loader2 className="ml-auto size-4 animate-spin text-slate-400" aria-hidden="true" />
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <TableRow
                  className={cn(bodyRowClassName, getRowClassName?.(row))}
                  data-state={row.getIsSelected() && "selected"}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = getColumnMeta(cell.column.columnDef);
                    const align = meta.align ?? "left";

                    return (
                      <TableCell
                        className={cn(
                          alignClassName[align],
                          meta.widthClassName,
                          meta.cellClassName,
                          cellClassName,
                        )}
                        key={cell.id}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                  {renderRowActions && (
                    <TableCell className={cn("whitespace-nowrap text-right", rowActionsClassName)}>
                      {renderRowActions(row)}
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="py-0" colSpan={visibleColumnCount}>
                  {renderEmptyState(emptyState as DataTableProps<unknown, unknown>["emptyState"])}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {paginationOptions && (
        <div
          aria-label={`${paginationOptions.label} 페이지`}
          className="flex min-h-10 min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        >
          <span className="min-w-0 text-xs font-semibold text-slate-500">
            {pageStart}-{pageEnd} / {totalRows} rows · {paginationState.pageIndex + 1} / {pageCount} pages
          </span>
          <div className="inline-flex flex-wrap items-center justify-end gap-2">
            {paginationOptions.showPageSize && (
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
                Rows
                <select
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700"
                  onChange={(event) => table.setPageSize(Number(event.target.value))}
                  value={paginationState.pageSize}
                >
                  {paginationOptions.pageSizeOptions.map((pageSize) => (
                    <option key={pageSize} value={pageSize}>
                      {pageSize}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
              size="sm"
              type="button"
              variant="outline"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
              Prev
            </Button>
            <Button
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
              size="sm"
              type="button"
              variant="outline"
            >
              Next
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
