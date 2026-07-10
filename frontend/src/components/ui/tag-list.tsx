import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const tagListVariants = cva("min-w-0", {
  defaultVariants: {
    align: "start",
    density: "default",
    layout: "row",
  },
  variants: {
    align: {
      center: "justify-center",
      end: "justify-end",
      start: "justify-start",
    },
    density: {
      compact: "gap-1.5",
      default: "gap-2",
      spacious: "gap-3",
    },
    layout: {
      grid: "grid grid-cols-[repeat(auto-fit,minmax(88px,max-content))]",
      row: "flex flex-wrap items-center",
    },
  },
});

export interface TagListProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof tagListVariants> {}

export const TagList = React.forwardRef<HTMLDivElement, TagListProps>(
  ({ align, className, density, layout, ...props }, ref) => (
    <div
      className={cn(tagListVariants({ align, className, density, layout }))}
      ref={ref}
      {...props}
    />
  ),
);
TagList.displayName = "TagList";
