import * as React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
  <nav
    aria-label="pagination"
    className={cn("mx-auto flex w-full justify-center", className)}
    {...props}
  />
);
Pagination.displayName = "Pagination";

export const PaginationContent = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(
  ({ className, ...props }, ref) => (
    <ul className={cn("flex flex-row items-center gap-1", className)} ref={ref} {...props} />
  ),
);
PaginationContent.displayName = "PaginationContent";

export const PaginationItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>(
  ({ className, ...props }, ref) => (
    <li className={cn("", className)} ref={ref} {...props} />
  ),
);
PaginationItem.displayName = "PaginationItem";

export interface PaginationLinkProps extends React.ComponentProps<"a"> {
  isActive?: boolean;
  size?: ButtonProps["size"];
}

export const PaginationLink = ({ className, isActive, size = "icon", ...props }: PaginationLinkProps) => (
  <a
    aria-current={isActive ? "page" : undefined}
    className={cn(
      buttonVariants({
        size,
        variant: isActive ? "outline" : "ghost",
      }),
      className,
    )}
    {...props}
  />
);
PaginationLink.displayName = "PaginationLink";

export interface PaginationControlProps extends React.ComponentProps<typeof Button> {
  label?: React.ReactNode;
}

export const PaginationPrevious = ({ children, label = "이전", ...props }: PaginationControlProps) => (
  <Button aria-label={typeof label === "string" ? label : undefined} size="sm" variant="ghost" {...props}>
    <ChevronLeft aria-hidden="true" />
    {children ?? label}
  </Button>
);
PaginationPrevious.displayName = "PaginationPrevious";

export const PaginationNext = ({ children, label = "다음", ...props }: PaginationControlProps) => (
  <Button aria-label={typeof label === "string" ? label : undefined} size="sm" variant="ghost" {...props}>
    {children ?? label}
    <ChevronRight aria-hidden="true" />
  </Button>
);
PaginationNext.displayName = "PaginationNext";

export const PaginationFirst = ({ children, label = "첫 페이지", ...props }: PaginationControlProps) => (
  <Button aria-label={typeof label === "string" ? label : undefined} size="icon" variant="ghost" {...props}>
    {children ?? <ChevronsLeft aria-hidden="true" />}
  </Button>
);
PaginationFirst.displayName = "PaginationFirst";

export const PaginationLast = ({ children, label = "마지막 페이지", ...props }: PaginationControlProps) => (
  <Button aria-label={typeof label === "string" ? label : undefined} size="icon" variant="ghost" {...props}>
    {children ?? <ChevronsRight aria-hidden="true" />}
  </Button>
);
PaginationLast.displayName = "PaginationLast";

export const PaginationEllipsis = ({ className, ...props }: React.ComponentProps<"span">) => (
  <span
    aria-hidden="true"
    className={cn("flex size-9 items-center justify-center", className)}
    {...props}
  >
    <span className="text-sm font-semibold tracking-normal text-slate-500">...</span>
    <span className="sr-only">More pages</span>
  </span>
);
PaginationEllipsis.displayName = "PaginationEllipsis";
