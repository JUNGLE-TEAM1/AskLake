import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const actionGroupVariants = cva("flex min-w-0 items-center", {
  defaultVariants: {
    align: "end",
    density: "default",
    wrap: "wrap",
  },
  variants: {
    align: {
      between: "justify-between",
      center: "justify-center",
      end: "justify-end",
      start: "justify-start",
    },
    density: {
      compact: "gap-2",
      default: "gap-3",
      spacious: "gap-4",
    },
    wrap: {
      nowrap: "flex-nowrap",
      wrap: "flex-wrap",
    },
  },
});

export interface ActionGroupProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof actionGroupVariants> {}

export const ActionGroup = React.forwardRef<HTMLDivElement, ActionGroupProps>(
  ({ align, className, density, wrap, ...props }, ref) => (
    <div
      className={cn(actionGroupVariants({ align, className, density, wrap }))}
      ref={ref}
      {...props}
    />
  ),
);
ActionGroup.displayName = "ActionGroup";
