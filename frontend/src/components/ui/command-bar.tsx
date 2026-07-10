import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const commandBarVariants = cva(
  "flex min-w-0 items-center gap-2",
  {
    defaultVariants: {
      density: "default",
      layout: "inline",
    },
    variants: {
      density: {
        compact: "min-h-10 px-3 py-2",
        default: "min-h-12 px-4 py-3",
        roomy: "min-h-14 px-5 py-4",
      },
      layout: {
        inline: "justify-end",
        split: "justify-between",
        sticky: "sticky bottom-0 z-10 border-t border-slate-200 bg-white shadow-[0_-8px_18px_rgb(15_23_42_/_6%)]",
        toolbar: "justify-start",
      },
    },
  },
);

export interface CommandBarProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof commandBarVariants> {}

export const CommandBar = React.forwardRef<HTMLDivElement, CommandBarProps>(
  ({ className, density, layout, ...props }, ref) => (
    <div
      className={cn(commandBarVariants({ className, density, layout }))}
      ref={ref}
      {...props}
    />
  ),
);
CommandBar.displayName = "CommandBar";
