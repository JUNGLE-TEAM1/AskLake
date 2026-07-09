import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const textareaVariants = cva(
  "flex min-h-24 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-950 shadow-sm transition-colors placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 disabled:opacity-70",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "border-slate-200",
        error: "border-red-300 focus-visible:ring-red-500",
        ghost: "border-transparent bg-slate-50 shadow-none",
      },
    },
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, ...props }, ref) => (
    <textarea
      className={cn(textareaVariants({ className, variant }))}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

