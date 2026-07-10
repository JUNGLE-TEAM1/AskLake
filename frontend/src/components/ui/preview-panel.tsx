import * as React from "react";

import { EmptyState, type EmptyStateProps } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

export interface PreviewPanelProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children" | "title"> {
  actions?: React.ReactNode;
  bodyClassName?: string;
  children?: React.ReactNode;
  description?: React.ReactNode;
  emptyState?: EmptyStateProps | React.ReactNode;
  eyebrow?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  headerClassName?: string;
  icon?: React.ReactNode;
  isEmpty?: boolean;
  meta?: React.ReactNode;
  title: React.ReactNode;
}

export const PreviewPanel = React.forwardRef<HTMLElement, PreviewPanelProps>(
  (
    {
      actions,
      bodyClassName,
      children,
      className,
      description,
      emptyState,
      eyebrow,
      footer,
      footerClassName,
      headerClassName,
      icon,
      isEmpty = false,
      meta,
      title,
      ...props
    },
    ref,
  ) => (
    <section className={className} ref={ref} {...props}>
      <div className={headerClassName}>
        <div className="min-w-0">
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {meta || actions || icon ? (
          <div className="inline-flex min-w-0 items-center justify-end gap-2">
            {meta}
            {actions}
            {icon}
          </div>
        ) : null}
      </div>
      <div className={bodyClassName}>
        {isEmpty && emptyState ? renderPreviewEmptyState(emptyState) : children}
      </div>
      {footer ? <div className={footerClassName}>{footer}</div> : null}
    </section>
  ),
);
PreviewPanel.displayName = "PreviewPanel";

function renderPreviewEmptyState(emptyState: PreviewPanelProps["emptyState"]) {
  if (!emptyState) return null;
  if (React.isValidElement(emptyState)) return emptyState;
  if (typeof emptyState !== "object" || !("title" in emptyState)) return emptyState;
  return <EmptyState size="sm" variant="plain" {...emptyState} />;
}

export interface ResultPanelProps extends PreviewPanelProps {
  status?: React.ReactNode;
  statusClassName?: string;
}

export const ResultPanel = React.forwardRef<HTMLElement, ResultPanelProps>(
  ({ meta, status, statusClassName, ...props }, ref) => (
    <PreviewPanel
      meta={status ? (
        <div className={cn("inline-flex items-center gap-2", statusClassName)}>
          {meta}
          {status}
        </div>
      ) : meta}
      ref={ref}
      {...props}
    />
  ),
);
ResultPanel.displayName = "ResultPanel";
