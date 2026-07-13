import * as React from "react";

import { cn } from "@/lib/utils";

export const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <table
    className={cn("w-full caption-bottom border-collapse text-sm", className)}
    ref={ref}
    {...props}
  />
));
Table.displayName = "Table";

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead className={cn("[&_tr]:border-b", className)} ref={ref} {...props} />
));
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    className={cn("[&_tr:last-child]:border-0", className)}
    ref={ref}
    {...props}
  />
));
TableBody.displayName = "TableBody";

export const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    className={cn("border-t bg-slate-50 font-medium [&>tr]:last:border-b-0", className)}
    ref={ref}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    className={cn(
      "border-b border-slate-200 transition-colors hover:bg-slate-50 data-[state=selected]:bg-slate-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    className={cn(
      "h-10 px-3 text-left align-middle text-xs font-semibold text-slate-500 [&:has([role=checkbox])]:pr-0",
      className,
    )}
    ref={ref}
    {...props}
  />
));
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    className={cn("px-3 py-3 align-middle text-slate-700 [&:has([role=checkbox])]:pr-0", className)}
    ref={ref}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    className={cn("mt-4 text-sm text-slate-500", className)}
    ref={ref}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";
