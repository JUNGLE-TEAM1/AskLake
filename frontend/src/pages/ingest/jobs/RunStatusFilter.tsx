import { Filter } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { JobRunStatus } from "../../../types";
import { getRunStatusFilterDotClassName, runStatusMeta } from "./jobShared";

export function RunStatusFilter({
  counts,
  onValueChange,
  statuses,
  value,
}: {
  counts: Record<JobRunStatus, number>;
  onValueChange: (status: "all" | JobRunStatus) => void;
  statuses: JobRunStatus[];
  value: "all" | JobRunStatus;
}) {
  const totalCount = Object.values(counts).reduce((total, count) => total + count, 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="실행 상태 필터"
          className="h-8 w-full justify-center gap-1.5 px-0 text-base font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
          size="sm"
          type="button"
          variant="ghost"
        >
          상태
          <Filter className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-48">
        <DropdownMenuLabel>실행 상태 필터</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={(nextValue) => onValueChange(nextValue as "all" | JobRunStatus)}>
          <DropdownMenuRadioItem className="gap-2 text-base" value="all">
            <span className="size-2 rounded-full bg-slate-500" aria-hidden="true" />
            <span>전체</span>
            <span className="ml-auto text-sm font-semibold tabular-nums text-slate-500">{totalCount}</span>
          </DropdownMenuRadioItem>
          {statuses.map((status) => (
            <DropdownMenuRadioItem className="gap-2 text-base" key={status} value={status}>
              <span className={cn("size-2 rounded-full", getRunStatusFilterDotClassName(status))} aria-hidden="true" />
              <span>{runStatusMeta[status].label}</span>
              <span className="ml-auto text-sm font-semibold tabular-nums text-slate-500">{counts[status]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
