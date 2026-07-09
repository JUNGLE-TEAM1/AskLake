import * as React from "react";

export interface DetailTableSectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children" | "title"> {
  actions?: React.ReactNode;
  children: React.ReactNode;
  emptyState?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  headerClassName?: string;
  isEmpty?: boolean;
  meta?: React.ReactNode;
  scrollClassName?: string;
  title: React.ReactNode;
}

export const DetailTableSection = React.forwardRef<HTMLElement, DetailTableSectionProps>(
  (
    {
      actions,
      children,
      className,
      emptyState,
      footer,
      footerClassName,
      headerClassName,
      isEmpty = false,
      meta,
      scrollClassName,
      title,
      ...props
    },
    ref,
  ) => (
    <article className={className} ref={ref} {...props}>
      <div className={headerClassName}>
        <h3>{title}</h3>
        {meta}
        {actions}
      </div>
      <div className={scrollClassName}>
        {isEmpty ? emptyState : children}
      </div>
      {footer ? <div className={footerClassName}>{footer}</div> : null}
    </article>
  ),
);
DetailTableSection.displayName = "DetailTableSection";
