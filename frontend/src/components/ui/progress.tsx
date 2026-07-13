import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

type ProgressContextValue = {
  max: number;
  value: number;
};

const ProgressContext = React.createContext<ProgressContextValue>({ max: 100, value: 0 });

export interface ProgressProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "value"> {
  indicatorClassName?: string;
  indeterminate?: boolean;
  max?: number;
  trackClassName?: string;
  value?: number;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ "aria-label": ariaLabel, children, className, indicatorClassName, indeterminate = false, max = 100, trackClassName, value = 0, ...props }, ref) => {
    const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
    const safeValue = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), safeMax);
    const percentage = Math.round((safeValue / safeMax) * 100);

    return (
      <ProgressContext.Provider value={{ max: safeMax, value: safeValue }}>
        <div
          className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5", className)}
          data-slot="progress"
          ref={ref}
          {...props}
        >
          {children}
          <ProgressPrimitive.Root
            aria-label={ariaLabel}
            className={cn("relative col-span-full h-2 w-full overflow-hidden rounded-full bg-slate-200", trackClassName)}
            data-slot="progress-track"
            max={safeMax}
            value={indeterminate ? null : safeValue}
          >
            <ProgressPrimitive.Indicator
              className={cn("h-full rounded-full bg-blue-600 transition-transform duration-300 ease-out", indicatorClassName)}
              data-slot="progress-indicator"
              style={indeterminate ? undefined : { transform: `translateX(-${100 - percentage}%)` }}
            />
          </ProgressPrimitive.Root>
        </div>
      </ProgressContext.Provider>
    );
  },
);
Progress.displayName = "Progress";

const ProgressLabel = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      className={cn("min-w-0 truncate text-left text-xs font-semibold leading-none text-slate-600", className)}
      data-slot="progress-label"
      ref={ref}
      {...props}
    />
  ),
);
ProgressLabel.displayName = "ProgressLabel";

interface ProgressValueProps extends React.HTMLAttributes<HTMLSpanElement> {
  maximumFractionDigits?: number;
}

const ProgressValue = React.forwardRef<HTMLSpanElement, ProgressValueProps>(
  ({ className, maximumFractionDigits = 0, ...props }, ref) => {
    const { max, value } = React.useContext(ProgressContext);
    const percentage = (value / max) * 100;
    const formattedPercentage = new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(percentage);

    return (
      <span
        className={cn("text-right text-xs font-bold leading-none tabular-nums text-slate-700", className)}
        data-slot="progress-value"
        ref={ref}
        {...props}
      >
        {formattedPercentage}%
      </span>
    );
  },
);
ProgressValue.displayName = "ProgressValue";

export { Progress, ProgressLabel, ProgressValue };
