import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const metricCardVariants = cva(
  "grid min-h-[78px] content-center rounded-lg border px-[18px] py-3.5 shadow-[inset_3px_0_0_currentColor]",
  {
    defaultVariants: {
      tone: "default",
    },
    variants: {
      tone: {
        attention: "border-amber-200 bg-amber-50 text-amber-700",
        default: "border-slate-200 bg-slate-50 text-slate-700",
        failed: "border-rose-200 bg-rose-50 text-rose-700",
        running: "border-emerald-200 bg-emerald-50 text-emerald-700",
        scheduled: "border-blue-200 bg-blue-50 text-blue-700",
        total: "border-blue-200 bg-sky-50 text-blue-700",
      },
    },
  },
);

export interface MetricCardProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof metricCardVariants> {
  active?: boolean;
  label: React.ReactNode;
  value: React.ReactNode;
}

export const MetricCard = React.forwardRef<HTMLElement, MetricCardProps>(
  ({ active, className, label, tone, value, ...props }, ref) => (
    <article
      className={cn(
        metricCardVariants({ tone }),
        active && "ring-1 ring-current/20",
        className,
      )}
      ref={ref}
      {...props}
    >
      <span className="text-3xl font-extrabold leading-none tracking-normal text-slate-950">
        {value}
      </span>
      <strong className="mt-1.5 text-xs font-bold leading-snug tracking-normal text-current">
        {label}
      </strong>
    </article>
  ),
);
MetricCard.displayName = "MetricCard";
