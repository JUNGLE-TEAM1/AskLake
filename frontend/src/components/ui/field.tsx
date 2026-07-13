import * as React from "react";

import { cn } from "@/lib/utils";

export const FieldSet = React.forwardRef<
  HTMLFieldSetElement,
  React.FieldsetHTMLAttributes<HTMLFieldSetElement>
>(({ className, ...props }, ref) => (
  <fieldset className={cn("grid min-w-0 gap-4", className)} ref={ref} {...props} />
));
FieldSet.displayName = "FieldSet";

export const FieldLegend = React.forwardRef<
  HTMLLegendElement,
  React.HTMLAttributes<HTMLLegendElement>
>(({ className, ...props }, ref) => (
  <legend
    className={cn("mb-1 text-base font-semibold tracking-normal text-slate-950", className)}
    ref={ref}
    {...props}
  />
));
FieldLegend.displayName = "FieldLegend";

export const FieldGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div className={cn("grid gap-4", className)} ref={ref} {...props} />
));
FieldGroup.displayName = "FieldGroup";

export const Field = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div className={cn("grid min-w-0 gap-2", className)} ref={ref} {...props} />
));
Field.displayName = "Field";

export const FieldContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div className={cn("grid min-w-0 gap-1.5", className)} ref={ref} {...props} />
));
FieldContent.displayName = "FieldContent";

export const FieldLabel = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    className={cn("text-sm font-semibold leading-none tracking-normal text-slate-700", className)}
    ref={ref}
    {...props}
  />
));
FieldLabel.displayName = "FieldLabel";

export const FieldTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    className={cn("text-sm font-semibold leading-none tracking-normal text-slate-900", className)}
    ref={ref}
    {...props}
  />
));
FieldTitle.displayName = "FieldTitle";

export const FieldDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p className={cn("text-sm leading-6 text-slate-500", className)} ref={ref} {...props} />
));
FieldDescription.displayName = "FieldDescription";

export const FieldError = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p className={cn("text-sm font-medium leading-6 text-red-600", className)} ref={ref} {...props} />
));
FieldError.displayName = "FieldError";

export const FieldSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div className={cn("h-px w-full bg-slate-200", className)} ref={ref} {...props} />
));
FieldSeparator.displayName = "FieldSeparator";

