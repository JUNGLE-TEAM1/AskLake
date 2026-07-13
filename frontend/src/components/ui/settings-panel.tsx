import * as React from "react";

export interface SettingsPanelProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children" | "title"> {
  actions?: React.ReactNode;
  bodyClassName?: string;
  children?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  header?: React.ReactNode;
  headerClassName?: string;
  title?: React.ReactNode;
}

export const SettingsPanel = React.forwardRef<HTMLElement, SettingsPanelProps>(
  (
    {
      actions,
      bodyClassName,
      children,
      description,
      footer,
      footerClassName,
      header,
      headerClassName,
      title,
      ...props
    },
    ref,
  ) => (
    <section ref={ref} {...props}>
      {header ?? (title || description || actions ? (
        <div className={headerClassName}>
          <div>
            {title ? <strong>{title}</strong> : null}
            {description ? <span>{description}</span> : null}
          </div>
          {actions}
        </div>
      ) : null)}
      <div className={bodyClassName}>{children}</div>
      {footer ? <div className={footerClassName}>{footer}</div> : null}
    </section>
  ),
);
SettingsPanel.displayName = "SettingsPanel";
