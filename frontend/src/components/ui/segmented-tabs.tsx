import * as React from "react";

import { cn } from "@/lib/utils";

export type SegmentedTabItem<Value extends string> = {
  disabled?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: Value;
};

export interface SegmentedTabsProps<Value extends string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  ariaLabel: string;
  buttonClassName?: string;
  items: Array<SegmentedTabItem<Value>>;
  onValueChange: (value: Value) => void;
  selectedButtonClassName?: string;
  value: Value;
}

export function SegmentedTabs<Value extends string>({
  ariaLabel,
  buttonClassName,
  className,
  items,
  onValueChange,
  selectedButtonClassName = "active",
  value,
  ...props
}: SegmentedTabsProps<Value>) {
  return (
    <div aria-label={ariaLabel} className={className} role="tablist" {...props}>
      {items.map((item) => {
        const isSelected = item.value === value;
        return (
          <button
            aria-selected={isSelected}
            className={cn(buttonClassName, isSelected && selectedButtonClassName)}
            disabled={item.disabled}
            key={item.value}
            role="tab"
            type="button"
            onClick={() => onValueChange(item.value)}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
