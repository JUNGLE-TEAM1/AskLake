import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const metricCardVariants = cva(
  "grid min-h-[116px] content-start gap-3 rounded-lg border bg-white px-5 py-4 shadow-[0_8px_24px_-20px_rgba(15,23,42,0.45)]",
  {
    defaultVariants: {
      tone: "default",
    },
    variants: {
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
  ({ active, className, detail, icon, label, tone, value, ...props }, ref) => (
    <article
      className={cn(
        metricCardVariants({ tone }),
        active && "ring-1 ring-current/20",
        className,
      )}
      ref={ref}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-current/10 [&_svg]:size-[18px]">
            {icon}
          </span>
        ) : null}
        <strong className="min-w-0 text-sm font-bold leading-snug tracking-normal text-slate-600">
          {label}
        </strong>
      </div>
      <span className="text-3xl font-extrabold leading-none tracking-normal text-slate-950">
        {value}
      </span>
      {detail ? (
        <span className="text-sm font-medium leading-snug tracking-normal text-slate-500">
          {detail}
        </span>
      ) : null}
    </article>
  ),
);
MetricCard.displayName = "MetricCard";
