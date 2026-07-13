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
      sm: "gap-3",
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
  return (
    <header className={cn(pageHeaderVariants({ className, size, variant }))} {...props}>
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className={cn("flex min-w-0 gap-3", leadingAlign === "center" ? "items-center" : "items-start")}>
          {icon && (
            <span className={cn(leadingAlign === "center" ? "mt-0" : "mt-1", "inline-flex size-14 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-blue-700 shadow-sm [&_svg]:size-7 sm:size-16 sm:[&_svg]:size-[30px]", iconClassName)}>
              {icon}
            </span>
          )}
          <div className="grid min-w-0 gap-2">
            {eyebrow && (
              <div className="text-xs font-semibold uppercase tracking-normal text-blue-700">
                {eyebrow}
              </div>
            )}
            <div className="grid min-w-0 gap-1">
              <h1 className={cn("text-3xl font-semibold leading-tight tracking-normal text-slate-950 sm:text-4xl", titleClassName)}>
                {title}
              </h1>
              {description && (
                <p className={cn("max-w-4xl text-base leading-7 text-slate-500 sm:text-xl sm:leading-8", descriptionClassName)}>
                  {description}
                </p>
              )}
            </div>
            {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
