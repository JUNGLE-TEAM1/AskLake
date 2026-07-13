import * as React from "react";

export type TreeHoverCardRow = {
  label: React.ReactNode;
  value: React.ReactNode;
};

export interface TreeHoverCardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  as?: "aside" | "div";
  bodyClassName?: string;
  description?: React.ReactNode;
  headerClassName?: string;
  icon: React.ReactNode;
  iconClassName?: string;
  rowLayout?: "flat" | "grouped";
  rows: TreeHoverCardRow[];
  subtitle?: React.ReactNode;
  title: React.ReactNode;
}

export function TreeHoverCard({
  as: Component = "div",
  bodyClassName,
  description,
  headerClassName,
  icon,
  iconClassName,
  rowLayout = "grouped",
  rows,
  subtitle,
  title,
  ...props
}: TreeHoverCardProps) {
  const details = (
    <dl>
      {rows.map((row) => (
        rowLayout === "flat" ? (
          <React.Fragment key={String(row.label)}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </React.Fragment>
        ) : (
          <div key={String(row.label)}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        )
      ))}
    </dl>
  );

  if (headerClassName) {
    return (
      <Component {...props}>
        <div className={headerClassName}>
          <span className={iconClassName} aria-hidden="true">{icon}</span>
          <div>
            <strong>{title}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
          </div>
        </div>
        {details}
        {description ? <p>{description}</p> : null}
      </Component>
    );
  }

  return (
    <Component {...props}>
      <div className={iconClassName} aria-hidden="true">{icon}</div>
      <div className={bodyClassName}>
        <strong>{title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
        {details}
        {description ? <p>{description}</p> : null}
      </div>
    </Component>
  );
}
