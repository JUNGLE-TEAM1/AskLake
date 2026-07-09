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
  summary?: React.ReactNode;
  title: React.ReactNode;
  titleClassName?: string;
  titleIcon?: React.ReactNode;
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
      summary,
      title,
      titleClassName,
      titleIcon,
      ...props
    },
    ref,
  ) => (
    <article className={className} ref={ref} {...props}>
      <div className={headerClassName}>
        <h3 className={titleClassName}>
          {titleIcon}
          {title}
        </h3>
        {meta}
        {actions}
      </div>
      {summary}
      <div className={scrollClassName}>
        {isEmpty ? emptyState : children}
      </div>
      {footer ? <div className={footerClassName}>{footer}</div> : null}
    </article>
  ),
);
DetailTableSection.displayName = "DetailTableSection";
