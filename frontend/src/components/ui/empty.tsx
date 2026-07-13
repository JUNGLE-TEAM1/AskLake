import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const emptyVariants = cva(
  "grid justify-items-center gap-4 text-center",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "min-h-56 p-8",
        lg: "min-h-72 p-10",
        sm: "min-h-40 p-6",
      },
      variant: {
        bordered: "rounded-lg border border-dashed border-slate-300 bg-white",
        default: "rounded-lg bg-slate-50",
        plain: "",
      },
    },
  },
);

export interface EmptyProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof emptyVariants> {}

export const Empty = React.forwardRef<HTMLDivElement, EmptyProps>(
  ({ className, size, variant, ...props }, ref) => (
    <div className={cn(emptyVariants({ className, size, variant }))} ref={ref} {...props} />
  ),
);
Empty.displayName = "Empty";

export const EmptyHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div className={cn("grid max-w-md gap-1", className)} ref={ref} {...props} />
));
EmptyHeader.displayName = "EmptyHeader";

export const EmptyTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    className={cn("text-base font-semibold leading-6 tracking-normal text-slate-950", className)}
    ref={ref}
    {...props}
  />
));
EmptyTitle.displayName = "EmptyTitle";

export const EmptyDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p className={cn("text-sm leading-6 text-slate-500", className)} ref={ref} {...props} />
));
EmptyDescription.displayName = "EmptyDescription";

export const EmptyIcon = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    className={cn(
      "inline-flex size-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-blue-700 shadow-sm",
      className,
    )}
    ref={ref}
    {...props}
  />
));
EmptyIcon.displayName = "EmptyIcon";

export const EmptyActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    className={cn("flex flex-wrap items-center justify-center gap-2 pt-1", className)}
    ref={ref}
    {...props}
  />
));
EmptyActions.displayName = "EmptyActions";

