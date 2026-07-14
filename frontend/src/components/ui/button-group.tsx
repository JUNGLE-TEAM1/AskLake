import * as React from "react";

import { cn } from "@/lib/utils";

export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

export const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, orientation = "horizontal", ...props }, ref) => (
    <div
      className={cn(
        "inline-flex w-fit items-stretch [&>*:focus-visible]:relative [&>*:focus-visible]:z-10",
        orientation === "horizontal" && "flex-row [&>*:not(:first-child)]:-ml-px [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none",
        orientation === "vertical" && "flex-col [&>*:not(:first-child)]:-mt-px [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none",
        className,
      )}
      data-orientation={orientation}
      ref={ref}
      role="group"
      {...props}
    />
  ),
);
ButtonGroup.displayName = "ButtonGroup";
