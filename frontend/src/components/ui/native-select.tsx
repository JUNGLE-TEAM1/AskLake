import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const nativeSelectVariants = cva(
  "flex w-full appearance-none rounded-lg border bg-white text-slate-950 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 disabled:opacity-70",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-10 px-3 py-2 pr-9 text-sm",
        lg: "h-11 px-4 py-2 pr-10 text-base",
        sm: "h-9 px-3 py-1.5 pr-8 text-sm",
      },
      variant: {
        default: "border-slate-200",
        error: "border-red-300 focus-visible:ring-red-500",
        ghost: "border-transparent bg-slate-50 shadow-none",
      },
    },
  },
);

export interface NativeSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">,
    VariantProps<typeof nativeSelectVariants> {}

export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, size, variant, ...props }, ref) => (
    <select className={cn(nativeSelectVariants({ className, size, variant }))} ref={ref} {...props} />
  ),
);
NativeSelect.displayName = "NativeSelect";
