import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const chipVariants = cva(
  "inline-flex min-w-0 items-center justify-center gap-1 rounded-full border font-medium tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      selected: false,
      size: "default",
      tone: "default",
    },
    variants: {
      selected: {
        false: "",
        true: "font-semibold ring-1 ring-blue-500/30",
      },
      size: {
        default: "min-h-6 px-2.5 py-0.5 text-xs",
        lg: "min-h-7 px-3 py-1 text-sm",
        sm: "min-h-5 px-2 py-0.5 text-[11px]",
      },
      tone: {
        danger: "border-red-100 bg-red-50 text-red-700",
        default: "border-blue-100 bg-blue-50 text-blue-700",
        muted: "border-slate-200 bg-slate-100 text-slate-600",
        outline: "border-slate-200 bg-white text-slate-700",
        secondary: "border-slate-200 bg-slate-50 text-slate-900",
        success: "border-emerald-100 bg-emerald-50 text-emerald-700",
        warning: "border-amber-100 bg-amber-50 text-amber-700",
      },
    },
  },
);

export interface ChipProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof chipVariants> {
  asChild?: boolean;
}

export const Chip = React.forwardRef<HTMLElement, ChipProps>(
  ({ asChild = false, className, selected, size, tone, ...props }, ref) => {
    const Comp = asChild ? Slot : "span";

    return (
      <Comp
        className={cn(chipVariants({ className, selected, size, tone }))}
        data-selected={selected || undefined}
        data-slot="chip"
        ref={ref}
        {...props}
      />
    );
  },
);
Chip.displayName = "Chip";
