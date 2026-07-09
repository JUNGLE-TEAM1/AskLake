import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const filterToolbarVariants = cva(
  "grid items-center border-t border-slate-100 bg-[#fbfdff] px-5 py-3",
  {
    defaultVariants: {
      layout: "actions",
    },
    variants: {
      layout: {
        actions: "grid-cols-[minmax(320px,1fr)_auto] gap-3.5 max-xl:grid-cols-1",
        filters: "grid-cols-[minmax(430px,1fr)_repeat(5,max-content)] gap-2 max-xl:grid-cols-2 max-sm:grid-cols-1 [&>*:first-child]:max-xl:col-span-full [&>*:last-child]:max-xl:col-span-full",
      },
    },
  },
);

export interface FilterToolbarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof filterToolbarVariants> {}

export const FilterToolbar = React.forwardRef<HTMLDivElement, FilterToolbarProps>(
  ({ className, layout, ...props }, ref) => (
    <div
      className={cn(filterToolbarVariants({ className, layout }))}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbar.displayName = "FilterToolbar";

const filterToolbarSearchVariants = cva(
  "flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 text-slate-500",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        compact: "min-h-[38px] px-3.5 text-[13px]",
        default: "min-h-[42px] px-4 text-sm",
      },
    },
  },
);

export interface FilterToolbarSearchProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof filterToolbarSearchVariants> {
  icon?: React.ReactNode;
}

export const FilterToolbarSearch = React.forwardRef<HTMLDivElement, FilterToolbarSearchProps>(
  ({ children, className, icon, size, ...props }, ref) => (
    <div
      className={cn(filterToolbarSearchVariants({ className, size }))}
      ref={ref}
      {...props}
    >
      {icon ? <span className="inline-flex shrink-0 text-current">{icon}</span> : null}
      {children}
    </div>
  ),
);
FilterToolbarSearch.displayName = "FilterToolbarSearch";

export const FilterToolbarSearchText = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      className={cn("min-w-0 overflow-hidden text-ellipsis whitespace-nowrap", className)}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbarSearchText.displayName = "FilterToolbarSearchText";

export const FilterToolbarActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("flex min-w-max items-center justify-end gap-3 max-xl:min-w-0 max-xl:justify-start max-sm:flex-wrap", className)}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbarActions.displayName = "FilterToolbarActions";

export const FilterToolbarMenu = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("relative", className)}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbarMenu.displayName = "FilterToolbarMenu";

export const FilterToolbarDivider = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      className={cn("h-10 w-px bg-slate-200 max-sm:hidden", className)}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbarDivider.displayName = "FilterToolbarDivider";
