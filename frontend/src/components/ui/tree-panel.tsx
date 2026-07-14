import * as React from "react";

export interface TreePanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  bodyClassName?: string;
  children?: React.ReactNode;
  emptyState?: React.ReactNode;
  errorState?: React.ReactNode;
  footer?: React.ReactNode;
  header?: React.ReactNode;
  isEmpty?: boolean;
  isError?: boolean;
  isLoading?: boolean;
  loadingState?: React.ReactNode;
  stateClassName?: string;
}

export const TreePanel = React.forwardRef<HTMLElement, TreePanelProps>(
  (
    {
      bodyClassName,
      children,
      emptyState,
      errorState,
      footer,
      header,
      isEmpty = false,
      isError = false,
      isLoading = false,
      loadingState,
      stateClassName,
      ...props
    },
    ref,
  ) => {
    const state = isLoading ? loadingState : isError ? errorState : isEmpty ? emptyState : null;
    const hasState = state !== null && state !== undefined;

    return (
      <section ref={ref} {...props}>
        {header}
        {hasState ? (
          <div className={stateClassName}>{state}</div>
        ) : bodyClassName ? (
          <div className={bodyClassName}>{children}</div>
        ) : (
          children
        )}
        {footer}
      </section>
    );
  },
);

TreePanel.displayName = "TreePanel";
