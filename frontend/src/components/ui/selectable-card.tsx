import * as React from "react";

import { cn } from "@/lib/utils";

export interface SelectableCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> {
  contentClassName?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  selected?: boolean;
  selectedClassName?: string;
  selectedIndicator?: React.ReactNode;
  title: React.ReactNode;
}

export const SelectableCard = React.forwardRef<HTMLButtonElement, SelectableCardProps>(
  (
    {
      className,
      contentClassName,
      description,
      icon,
      selected = false,
      selectedClassName = "active",
      selectedIndicator,
      title,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      aria-pressed={selected}
      className={cn(className, selected && selectedClassName)}
      ref={ref}
      type={type}
      {...props}
    >
      {selected ? selectedIndicator : null}
      {icon}
      {contentClassName ? (
        <span className={contentClassName}>
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </span>
      ) : (
        <>
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </>
      )}
    </button>
  ),
);
SelectableCard.displayName = "SelectableCard";
