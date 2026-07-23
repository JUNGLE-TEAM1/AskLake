import * as React from "react";

import { cn } from "@/lib/utils";

export const DataTableStackedCell = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    className={cn("grid min-w-0 gap-1", className)}
    ref={ref}
    {...props}
  />
));
DataTableStackedCell.displayName = "DataTableStackedCell";

export const DataTableCellPrimary = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <strong
    className={cn("min-w-0 truncate text-base font-semibold text-slate-950", className)}
    data-slot="data-table-primary"
    ref={ref}
    {...props}
  />
));
DataTableCellPrimary.displayName = "DataTableCellPrimary";

export const DataTableCellSecondary = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    className={cn("min-w-0 truncate text-sm font-normal text-slate-500", className)}
    data-slot="data-table-secondary"
    ref={ref}
    {...props}
  />
));
DataTableCellSecondary.displayName = "DataTableCellSecondary";
