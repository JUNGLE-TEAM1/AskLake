import * as React from "react";

import { NativeSelect, type NativeSelectProps } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export interface FormFieldGroupProps
  extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "children"> {
  children: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  label: React.ReactNode;
  labelClassName?: string;
  meta?: React.ReactNode;
}

export const FormFieldGroup = React.forwardRef<HTMLLabelElement, FormFieldGroupProps>(
  ({ children, className, error, hint, label, labelClassName, meta, ...props }, ref) => (
    <label className={className} ref={ref} {...props}>
      <span className={labelClassName}>{label}</span>
      {children}
      {hint || error || meta ? (
        <small className={cn(error && "text-red-600")}>
          {error ?? hint ?? meta}
        </small>
      ) : null}
    </label>
  ),
);
FormFieldGroup.displayName = "FormFieldGroup";

export interface NativeSelectFieldProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children" | "size"> {
  children: React.ReactNode;
  error?: React.ReactNode;
  fieldClassName?: string;
  hint?: React.ReactNode;
  label: React.ReactNode;
  selectClassName?: string;
  size?: NativeSelectProps["size"];
  variant?: NativeSelectProps["variant"];
}

export const NativeSelectField = React.forwardRef<HTMLSelectElement, NativeSelectFieldProps>(
  (
    {
      children,
      className,
      error,
      fieldClassName,
      hint,
      label,
      selectClassName,
      size = "sm",
      variant,
      ...props
    },
    ref,
  ) => (
    <FormFieldGroup className={fieldClassName} error={error} hint={hint} label={label}>
      <NativeSelect
        className={cn(selectClassName, className)}
        ref={ref}
        size={size}
        variant={variant}
        {...props}
      >
        {children}
      </NativeSelect>
    </FormFieldGroup>
  ),
);
NativeSelectField.displayName = "NativeSelectField";
