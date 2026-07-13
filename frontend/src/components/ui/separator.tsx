import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "@/lib/utils";

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, decorative = true, orientation = "horizontal", ...props }, ref) => (
  <SeparatorPrimitive.Root
    className={cn(
      "shrink-0 bg-slate-200",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    decorative={decorative}
    orientation={orientation}
    ref={ref}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

