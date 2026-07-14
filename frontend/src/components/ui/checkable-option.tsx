import * as React from "react";

import { cn } from "@/lib/utils";

export interface CheckableOptionProps
  extends Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "children" | "title"> {
  checked?: boolean;
  checkedClassName?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  disabledClassName?: string;
  inputClassName?: string;
  inputName?: string;
  inputType?: "checkbox" | "radio";
  inputValue?: string;
  onCheckedChange?: (checked: boolean) => void;
}

export const CheckableOption = React.forwardRef<HTMLLabelElement, CheckableOptionProps>(
  (
    {
      checked = false,
      checkedClassName = "active",
      children,
      className,
      disabled = false,
      disabledClassName = "disabled",
      inputClassName,
      inputName,
      inputType = "checkbox",
      inputValue,
      onCheckedChange,
      ...props
    },
    ref,
  ) => (
    <label
      className={cn(className, checked && checkedClassName, disabled && disabledClassName)}
      ref={ref}
      {...props}
    >
      <input
        checked={checked}
        className={inputClassName}
        disabled={disabled}
        name={inputName}
        type={inputType}
        value={inputValue}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
      {children}
    </label>
  ),
);
CheckableOption.displayName = "CheckableOption";
