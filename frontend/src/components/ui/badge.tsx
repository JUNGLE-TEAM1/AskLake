import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 border font-medium tracking-normal transition-colors",
  {
    defaultVariants: {
      shape: "default",
      size: "default",
      variant: "default",
    },
    variants: {
      shape: {
        compact: "rounded-md",
        default: "rounded-full",
      },
      size: {
        default: "min-h-6 px-2.5 py-0.5 text-xs",
        lg: "min-h-7 px-3 py-1 text-sm",
        sm: "min-h-5 px-2 py-0.5 text-[11px]",
      },
      variant: {
        default: "border-blue-100 bg-blue-50 text-blue-700",
        destructive: "border-red-100 bg-red-50 font-semibold text-red-700",
        muted: "border-slate-200 bg-slate-100 text-slate-600",
        outline: "border-slate-200 bg-white text-slate-700",
        secondary: "border-slate-200 bg-slate-50 text-slate-900",
        success: "border-emerald-100 bg-emerald-50 font-semibold text-emerald-700",
        warning: "border-amber-100 bg-amber-50 font-semibold text-amber-700",
      },
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, shape, size, variant, ...props }, ref) => (
    <span
      className={cn(badgeVariants({ className, shape, size, variant }))}
      data-slot="badge"
      data-variant={variant ?? "default"}
      ref={ref}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
