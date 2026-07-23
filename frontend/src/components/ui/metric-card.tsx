import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const metricCardVariants = cva(
  "grid content-start rounded-lg border bg-white shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]",
  {
    defaultVariants: {
      size: "default",
      tone: "default",
    },
    variants: {
      size: {
        compact: "min-h-[104px] gap-2.5 px-4 py-3.5",
        default: "min-h-[116px] gap-3 px-5 py-4",
      },
      tone: {
        attention: "border-amber-200 text-amber-700",
        default: "border-slate-200 text-slate-600",
        failed: "border-rose-200 text-rose-700",
        running: "border-emerald-200 text-emerald-700",
        scheduled: "border-blue-200 text-blue-700",
        total: "border-sky-200 text-sky-700",
      },
    },
  },
);

export interface MetricCardProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof metricCardVariants> {
  active?: boolean;
  detail?: React.ReactNode;
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
}

export const MetricCard = React.forwardRef<HTMLElement, MetricCardProps>(
  ({ active, className, detail, icon, label, size = "default", tone, value, ...props }, ref) => (
    <article
      className={cn(
        metricCardVariants({ size, tone }),
        active && "ring-1 ring-current/20",
        className,
      )}
      ref={ref}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span className={cn(
            "grid shrink-0 place-items-center rounded-lg bg-current/10",
            size === "compact" ? "size-8 [&_svg]:size-4" : "size-9 [&_svg]:size-[18px]",
          )}>
            {icon}
          </span>
        ) : null}
        <strong className={cn(
          "min-w-0 font-medium leading-snug tracking-normal text-slate-600",
          size === "compact" ? "text-[13px]" : "text-sm",
        )} data-slot="metric-label">
          {label}
        </strong>
      </div>
      <span className={cn(
        "font-bold leading-none tracking-normal text-slate-950",
        size === "compact" ? "text-2xl" : "text-3xl",
      )} data-slot="metric-value">
        {value}
      </span>
      {detail ? (
        <span className={cn(
          "font-normal leading-snug tracking-normal text-slate-500",
          size === "compact" ? "text-xs" : "text-sm",
        )} data-slot="metric-detail">
          {detail}
        </span>
      ) : null}
    </article>
  ),
);
MetricCard.displayName = "MetricCard";
