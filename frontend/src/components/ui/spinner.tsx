import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export const Spinner = React.forwardRef<SVGSVGElement, React.ComponentProps<typeof Loader2>>(
  ({ className, "aria-label": ariaLabel = "로딩 중", ...props }, ref) => (
    <Loader2
      aria-label={ariaLabel}
      className={cn("size-4 animate-spin", className)}
      ref={ref}
      role="status"
      {...props}
    />
  ),
);
Spinner.displayName = "Spinner";
