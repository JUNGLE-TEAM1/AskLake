import * as React from "react";

export interface WidgetShellProps extends React.HTMLAttributes<HTMLElement> {
  bodyClassName?: string;
  children?: React.ReactNode;
  header?: React.ReactNode;
  overlay?: React.ReactNode;
}

export const WidgetShell = React.forwardRef<HTMLElement, WidgetShellProps>(
  ({ bodyClassName, children, header, overlay, ...props }, ref) => (
    <article ref={ref} {...props}>
      {header}
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
      {overlay}
    </article>
  ),
);

WidgetShell.displayName = "WidgetShell";

export interface WidgetShellHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  action?: React.ReactNode;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
}

export const WidgetShellHeader = React.forwardRef<HTMLElement, WidgetShellHeaderProps>(
  ({ action, eyebrow, title, ...props }, ref) => (
    <header ref={ref} {...props}>
      <div>
        {eyebrow ? <span>{eyebrow}</span> : null}
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  ),
);

WidgetShellHeader.displayName = "WidgetShellHeader";
