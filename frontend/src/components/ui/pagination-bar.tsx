import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PaginationBarProps extends React.HTMLAttributes<HTMLDivElement> {
  actionsClassName?: string;
  buttonSize?: ButtonProps["size"];
  buttonVariant?: ButtonProps["variant"];
  currentPage?: number;
  nextAriaLabel?: string;
  nextDisabled?: boolean;
  nextLabel?: React.ReactNode;
  onNext: () => void;
  onPrevious: () => void;
  pageLabel?: React.ReactNode;
  previousAriaLabel?: string;
  previousDisabled?: boolean;
  previousLabel?: React.ReactNode;
  rangeLabel?: React.ReactNode;
  summaryClassName?: string;
  totalPages?: number;
}

export const PaginationBar = React.forwardRef<HTMLDivElement, PaginationBarProps>(
  (
    {
      actionsClassName,
      buttonSize = "sm",
      buttonVariant = "outline",
      className,
      currentPage,
      nextAriaLabel = "다음 페이지",
      nextDisabled,
      nextLabel,
      onNext,
      onPrevious,
      pageLabel,
      previousAriaLabel = "이전 페이지",
      previousDisabled,
      previousLabel,
      rangeLabel,
      summaryClassName,
      totalPages,
      ...props
    },
    ref,
  ) => {
    const hasPageState = typeof currentPage === "number" && typeof totalPages === "number";
    const resolvedPreviousDisabled = previousDisabled ?? (hasPageState ? currentPage <= 1 : false);
    const resolvedNextDisabled = nextDisabled ?? (hasPageState ? currentPage >= totalPages : false);
    const resolvedPageLabel = pageLabel ?? (hasPageState ? `${currentPage} / ${totalPages}` : null);

    return (
      <div
        className={cn(
          "flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2",
          className,
        )}
        ref={ref}
        {...props}
      >
        {rangeLabel ? (
          <span className={cn("min-w-0 text-xs font-bold text-slate-500", summaryClassName)}>
            {rangeLabel}
          </span>
        ) : null}
        <div className={cn("inline-flex shrink-0 items-center justify-end gap-2", actionsClassName)}>
          <Button
            aria-label={previousAriaLabel}
            disabled={resolvedPreviousDisabled}
            onClick={onPrevious}
            size={buttonSize}
            type="button"
            variant={buttonVariant}
          >
            {previousLabel ?? (
              <>
                <ChevronLeft aria-hidden="true" />
                이전
              </>
            )}
          </Button>
          {resolvedPageLabel ? (
            <strong className="whitespace-nowrap text-xs font-black text-slate-500">
              {resolvedPageLabel}
            </strong>
          ) : null}
          <Button
            aria-label={nextAriaLabel}
            disabled={resolvedNextDisabled}
            onClick={onNext}
            size={buttonSize}
            type="button"
            variant={buttonVariant}
          >
            {nextLabel ?? (
              <>
                다음
                <ChevronRight aria-hidden="true" />
              </>
            )}
          </Button>
        </div>
      </div>
    );
  },
);
PaginationBar.displayName = "PaginationBar";
