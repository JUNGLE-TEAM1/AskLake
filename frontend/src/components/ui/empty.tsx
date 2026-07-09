import * as React from "react";

import { cn } from "@/lib/utils";

export const Empty = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("grid min-h-48 place-items-center gap-4 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center", className)}
      ref={ref}
      {...props}
    />
  ),
);
Empty.displayName = "Empty";

export const EmptyHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("grid justify-items-center gap-2", className)} ref={ref} {...props} />
  ),
);
EmptyHeader.displayName = "EmptyHeader";

export const EmptyMedia = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      className={cn("inline-flex size-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-blue-700", className)}
      ref={ref}
      {...props}
    />
  ),
);
EmptyMedia.displayName = "EmptyMedia";

export const EmptyTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 className={cn("text-base font-semibold leading-6 tracking-normal text-slate-950", className)} ref={ref} {...props} />
  ),
);
EmptyTitle.displayName = "EmptyTitle";

export const EmptyDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p className={cn("max-w-md text-sm leading-6 text-slate-500", className)} ref={ref} {...props} />
  ),
);
EmptyDescription.displayName = "EmptyDescription";

export const EmptyContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("grid justify-items-center gap-1", className)} ref={ref} {...props} />
  ),
);
EmptyContent.displayName = "EmptyContent";

export const EmptyActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("flex flex-wrap items-center justify-center gap-2", className)} ref={ref} {...props} />
  ),
);
EmptyActions.displayName = "EmptyActions";
