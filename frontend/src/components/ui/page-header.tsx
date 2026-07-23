import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const pageHeaderVariants = cva("flex min-w-0 flex-col gap-4", {
  defaultVariants: {
    size: "default",
    variant: "default",
  },
  variants: {
    size: {
      default: "",
      lg: "gap-5",
      sm: "gap-2",
    },
    variant: {
      bordered: "border-b border-slate-200 pb-5",
      default: "",
      subtle: "rounded-lg bg-slate-50 p-5",
    },
  },
});

export interface PageHeaderProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title">,
    VariantProps<typeof pageHeaderVariants> {
  actions?: React.ReactNode;
  description?: React.ReactNode;
  descriptionClassName?: string;
  eyebrow?: React.ReactNode;
  icon?: React.ReactNode;
  iconClassName?: string;
  leadingAlign?: "center" | "start";
  meta?: React.ReactNode;
  title: React.ReactNode;
  titleClassName?: string;
}

export function PageHeader({
  actions,
  className,
  description,
  descriptionClassName,
  eyebrow,
  icon,
  iconClassName,
  leadingAlign = "start",
  meta,
  size,
  title,
  titleClassName,
  variant,
  ...props
}: PageHeaderProps) {
  const compact = size === "sm";

  return (
    <header className={cn(pageHeaderVariants({ className, size, variant }))} {...props}>
      <div className={cn("flex min-w-0 flex-col sm:flex-row sm:justify-between", compact ? "gap-2 sm:items-center" : "gap-4 sm:items-start")}>
        <div className={cn("flex min-w-0", compact ? "gap-2" : "gap-3", leadingAlign === "center" ? "items-center" : "items-start")}>
          {icon && (
            <span className={cn(
              "inline-flex shrink-0 items-center justify-center border border-slate-200 bg-white text-blue-700 shadow-sm",
              compact
                ? "mt-0 size-9 rounded-lg [&_svg]:size-[18px] sm:size-10 sm:[&_svg]:size-5"
                : cn(leadingAlign === "center" ? "mt-0" : "mt-1", "size-14 rounded-xl [&_svg]:size-7 sm:size-16 sm:[&_svg]:size-[30px]"),
              iconClassName,
            )}>
              {icon}
            </span>
          )}
          <div className={cn("grid min-w-0", compact ? "gap-1" : "gap-2")}>
            {eyebrow && (
              <div className="text-xs font-medium uppercase tracking-normal text-blue-700" data-slot="page-eyebrow">
                {eyebrow}
              </div>
            )}
            <div className={cn("grid min-w-0", compact ? "gap-0.5" : "gap-1")}>
              <h1 className={cn(
                "font-bold leading-tight tracking-normal text-slate-950",
                compact ? "text-2xl sm:text-[28px]" : "text-3xl sm:text-4xl",
                titleClassName,
              )} data-slot="page-title">
                {title}
              </h1>
              {description && (
                <p className={cn(
                  "max-w-4xl text-slate-500",
                  compact ? "text-sm leading-6 sm:text-base" : "text-base leading-7 sm:text-xl sm:leading-8",
                  descriptionClassName,
                )}>
                  {description}
                </p>
              )}
            </div>
            {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className={cn("flex shrink-0 flex-wrap items-center gap-2", compact && "sm:self-center")}>{actions}</div>}
      </div>
    </header>
  );
}
