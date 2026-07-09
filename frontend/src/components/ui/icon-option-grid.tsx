import * as React from "react";

import { cn } from "@/lib/utils";

export type IconOptionGridItem<Value extends string> = {
  description?: string;
  icon: React.ReactNode;
  label: string;
  value: Value;
};

export interface IconOptionGridProps<Value extends string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  ariaLabel?: string;
  buttonClassName?: string;
  items: Array<IconOptionGridItem<Value>>;
  onOptionBlur?: () => void;
  onOptionFocus?: (event: React.FocusEvent<HTMLButtonElement>, item: IconOptionGridItem<Value>) => void;
  onOptionMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>, item: IconOptionGridItem<Value>) => void;
  onOptionMouseLeave?: () => void;
  onValueChange: (value: Value) => void;
  selectedButtonClassName?: string;
  value: Value;
}

export function IconOptionGrid<Value extends string>({
  ariaLabel,
  buttonClassName,
  className,
  items,
  onOptionBlur,
  onOptionFocus,
  onOptionMouseEnter,
  onOptionMouseLeave,
  onValueChange,
  selectedButtonClassName = "selected",
  value,
  ...props
}: IconOptionGridProps<Value>) {
  return (
    <div aria-label={ariaLabel} className={className} role="radiogroup" {...props}>
      {items.map((item) => {
        const isSelected = item.value === value;
        const label = item.description ? `${item.label}: ${item.description}` : item.label;
        return (
          <button
            aria-checked={isSelected}
            aria-label={label}
            className={cn(buttonClassName, isSelected && selectedButtonClassName)}
            key={item.value}
            role="radio"
            title={label}
            type="button"
            onBlur={onOptionBlur}
            onFocus={(event) => onOptionFocus?.(event, item)}
            onClick={() => onValueChange(item.value)}
            onMouseEnter={(event) => onOptionMouseEnter?.(event, item)}
            onMouseLeave={onOptionMouseLeave}
          >
            {item.icon}
          </button>
        );
      })}
    </div>
  );
}
