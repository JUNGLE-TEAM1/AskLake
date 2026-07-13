import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export type KeyValueListItem = {
  className?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  descriptionTitle?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  valueClassName?: string;
};

export const keyValueListVariants = cva("min-w-0", {
  defaultVariants: {
    density: "default",
    layout: "grid",
  },
  variants: {
    density: {
      compact: "gap-2",
      default: "gap-3",
      spacious: "gap-4",
    },
    layout: {
      grid: "grid",
      inline: "flex flex-wrap",
      stack: "grid",
    },
  },
});

export interface KeyValueListProps
  extends Omit<React.HTMLAttributes<HTMLDListElement>, "children">,
    VariantProps<typeof keyValueListVariants> {
  items: KeyValueListItem[];
}

export const KeyValueList = React.forwardRef<HTMLDListElement, KeyValueListProps>(
  ({ className, density, items, layout, ...props }, ref) => (
    <dl
      className={cn(keyValueListVariants({ className, density, layout }))}
      ref={ref}
      {...props}
    >
      {items.map((item, index) => (
        <div className={item.className} key={`${String(item.label)}-${index}`}>
          <dt>{item.label}</dt>
          <dd className={item.valueClassName}>{item.value}</dd>
          {item.description ? <dd className={item.descriptionClassName} title={item.descriptionTitle}>{item.description}</dd> : null}
        </div>
      ))}
    </dl>
  ),
);
KeyValueList.displayName = "KeyValueList";
