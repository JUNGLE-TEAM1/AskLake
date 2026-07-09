import * as React from "react";

import { Label, type LabelProps } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  ({ className, orientation = "vertical", ...props }, ref) => (
    <div
      className={cn(
        "grid gap-2",
        orientation === "horizontal" && "items-start gap-3 sm:grid-cols-[minmax(10rem,14rem)_1fr]",
        className,
      )}
      data-orientation={orientation}
      ref={ref}
      {...props}
    />
  ),
);
Field.displayName = "Field";

export const FieldLabel = React.forwardRef<
  React.ElementRef<typeof Label>,
  LabelProps
>(({ className, ...props }, ref) => (
  <Label className={cn("min-w-0", className)} ref={ref} {...props} />
));
FieldLabel.displayName = "FieldLabel";

export const FieldContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("grid min-w-0 gap-2", className)} ref={ref} {...props} />
  ),
);
FieldContent.displayName = "FieldContent";

export const FieldDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p className={cn("text-xs leading-5 text-slate-500", className)} ref={ref} {...props} />
));
FieldDescription.displayName = "FieldDescription";

export const FieldError = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p className={cn("text-xs font-semibold leading-5 text-red-600", className)} ref={ref} {...props} />
));
FieldError.displayName = "FieldError";

export const FieldGroup = React.forwardRef<HTMLFieldSetElement, React.FieldsetHTMLAttributes<HTMLFieldSetElement>>(
  ({ className, ...props }, ref) => (
    <fieldset className={cn("grid gap-3", className)} ref={ref} {...props} />
  ),
);
FieldGroup.displayName = "FieldGroup";

export const FieldLegend = React.forwardRef<HTMLLegendElement, React.HTMLAttributes<HTMLLegendElement>>(
  ({ className, ...props }, ref) => (
    <legend
      className={cn("mb-2 text-sm font-semibold tracking-normal text-slate-900", className)}
      ref={ref}
      {...props}
    />
  ),
);
FieldLegend.displayName = "FieldLegend";
