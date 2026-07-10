import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const inputVariants = cva(
  "flex w-full rounded-lg border bg-white text-slate-950 shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 disabled:opacity-70",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-10 px-3 py-2 text-sm",
        lg: "h-11 px-4 py-2 text-base",
        sm: "h-9 px-3 py-1.5 text-sm",
      },
      variant: {
        default: "border-slate-200",
        error: "border-red-300 focus-visible:ring-red-500",
        ghost: "border-transparent bg-slate-50 shadow-none",
      },
    },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, type, variant, ...props }, ref) => (
    <input
      className={cn(inputVariants({ className, size, variant }))}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);
Input.displayName = "Input";
