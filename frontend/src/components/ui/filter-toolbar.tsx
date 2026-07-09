import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Input, type InputProps } from "@/components/ui/input";
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
        stacked: "grid-cols-1 gap-3",
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

export const FilterToolbarInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <Input
      className={cn("h-auto min-w-0 border-0 bg-transparent px-0 py-0 text-sm font-semibold shadow-none placeholder:text-slate-400 focus-visible:ring-0 focus-visible:ring-offset-0", className)}
      ref={ref}
      variant="ghost"
      {...props}
    />
  ),
);
FilterToolbarInput.displayName = "FilterToolbarInput";

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

export interface FilterToolbarFieldGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
}

export const FilterToolbarFieldGroup = React.forwardRef<HTMLDivElement, FilterToolbarFieldGroupProps>(
  ({ children, className, label, ...props }, ref) => (
    <div
      className={cn("grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-3 max-sm:grid-cols-1", className)}
      ref={ref}
      {...props}
    >
      {label ? (
        <span className="inline-flex min-h-9 items-center text-sm font-bold text-slate-900">
          {label}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        {children}
      </div>
    </div>
  ),
);
FilterToolbarFieldGroup.displayName = "FilterToolbarFieldGroup";

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

export const FilterToolbarCheckboxGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-3", className)}
      ref={ref}
      {...props}
    />
  ),
);
FilterToolbarCheckboxGroup.displayName = "FilterToolbarCheckboxGroup";

export interface FilterToolbarCheckboxProps
  extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "onChange"> {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const FilterToolbarCheckbox = React.forwardRef<HTMLLabelElement, FilterToolbarCheckboxProps>(
  ({ checked, children, className, disabled, onCheckedChange, ...props }, ref) => (
    <label
      className={cn("inline-flex min-h-8 items-center gap-2 text-sm font-bold text-slate-600", disabled && "cursor-not-allowed opacity-50", className)}
      ref={ref}
      {...props}
    >
      <input
        checked={checked}
        className="size-[18px] rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  ),
);
FilterToolbarCheckbox.displayName = "FilterToolbarCheckbox";

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
