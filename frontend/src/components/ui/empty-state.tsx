import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const emptyStateVariants = cva(
  "grid justify-items-center gap-3 text-center",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "min-h-56 p-8",
        lg: "min-h-72 p-10",
        sm: "min-h-40 p-6",
      },
      variant: {
        bordered: "rounded-lg border border-dashed border-slate-300 bg-white",
        default: "rounded-lg bg-slate-50",
        plain: "",
      },
    },
  },
);

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof emptyStateVariants> {
  action?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  title: React.ReactNode;
}

export function EmptyState({
  action,
  className,
  description,
  icon,
  secondaryAction,
  size,
  title,
  variant,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn(emptyStateVariants({ className, size, variant }))} {...props}>
      {icon && (
        <span className="inline-flex size-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-blue-700 shadow-sm">
          {icon}
        </span>
      )}
      <div className="grid max-w-md gap-1">
        <h2 className="text-base font-semibold leading-6 tracking-normal text-slate-950">
          {title}
        </h2>
        {description && (
          <p className="text-sm leading-6 text-slate-500">
            {description}
          </p>
        )}
      </div>
      {(action || secondaryAction) && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
