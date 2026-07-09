import * as React from "react";
import { AlertTriangle, Check, CircleDot, X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export type ValidationListStatus = "error" | "muted" | "pending" | "ready" | "success" | "warning";

export type ValidationListItem = {
  className?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  label: React.ReactNode;
  status?: ValidationListStatus;
  value?: React.ReactNode;
};

export const validationListVariants = cva("min-w-0", {
  defaultVariants: {
    density: "default",
  },
  variants: {
    density: {
      compact: "gap-2",
      default: "gap-3",
      spacious: "gap-4",
    },
  },
});

const validationItemClassNameByStatus: Record<ValidationListStatus, string> = {
  error: "needs-review",
  muted: "",
  pending: "needs-review",
  ready: "ready",
  success: "ready",
  warning: "needs-review",
};

function ValidationIcon({ status }: { status: ValidationListStatus }) {
  if (status === "error") return <X size={15} />;
  if (status === "warning") return <AlertTriangle size={15} />;
  if (status === "pending" || status === "muted") return <CircleDot size={15} />;
  return <Check size={15} />;
}

export interface ValidationListProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof validationListVariants> {
  items: ValidationListItem[];
}

export const ValidationList = React.forwardRef<HTMLDivElement, ValidationListProps>(
  ({ className, density, items, ...props }, ref) => (
    <div
      className={cn(validationListVariants({ className, density }))}
      ref={ref}
      {...props}
    >
      {items.map((item, index) => {
        const status = item.status ?? "muted";

        return (
          <div
            className={cn(validationItemClassNameByStatus[status], item.className)}
            key={`${String(item.label)}-${index}`}
          >
            {item.icon ?? <ValidationIcon status={status} />}
            <span>{item.label}</span>
            {item.value ? <strong>{item.value}</strong> : null}
            {item.description ? <small>{item.description}</small> : null}
          </div>
        );
      })}
    </div>
  ),
);
ValidationList.displayName = "ValidationList";
