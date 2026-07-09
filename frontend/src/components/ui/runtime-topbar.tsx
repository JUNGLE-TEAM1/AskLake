import * as React from "react";

export interface RuntimeTopbarProps extends React.HTMLAttributes<HTMLElement> {
  actions?: React.ReactNode;
  actionsClassName?: string;
  titleSlot: React.ReactNode;
}

export const RuntimeTopbar = React.forwardRef<HTMLElement, RuntimeTopbarProps>(
  ({ actions, actionsClassName, titleSlot, ...props }, ref) => (
    <header ref={ref} {...props}>
      {titleSlot}
      {actions ? <div className={actionsClassName}>{actions}</div> : null}
    </header>
  ),
);

RuntimeTopbar.displayName = "RuntimeTopbar";
