import * as React from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

export type StatusBadgeTone = "danger" | "default" | "muted" | "outline" | "success" | "warning";

const statusBadgeVariantByTone: Record<StatusBadgeTone, BadgeProps["variant"]> = {
  danger: "destructive",
  default: "default",
  muted: "muted",
  outline: "outline",
  success: "success",
  warning: "warning",
};

export interface StatusBadgeProps extends Omit<BadgeProps, "variant"> {
  label?: React.ReactNode;
  tone?: StatusBadgeTone;
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ children, label, tone = "default", ...props }, ref) => (
    <Badge data-status="true" ref={ref} variant={statusBadgeVariantByTone[tone]} {...props}>
      {children ?? label}
    </Badge>
  ),
);
StatusBadge.displayName = "StatusBadge";
