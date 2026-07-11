import * as React from "react";

import { cn } from "@/lib/utils";

type TreeRowStateProps = {
  expanded?: boolean;
  leaf?: boolean;
  level?: number;
  selected?: boolean;
};

function treeRowStateProps({ expanded, leaf, level, selected }: TreeRowStateProps) {
  return {
    "aria-expanded": leaf ? undefined : expanded,
    "aria-selected": selected || undefined,
    "data-expanded": expanded ? "true" : undefined,
    "data-leaf": leaf ? "true" : undefined,
    "data-level": level,
    "data-selected": selected ? "true" : undefined,
  };
}

export interface TreeViewProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export const TreeView = React.forwardRef<HTMLDivElement, TreeViewProps>(
  ({ className, label, role = "tree", ...props }, ref) => (
    <div
      aria-label={label}
      className={cn("asklake-tree-view", className)}
      ref={ref}
      role={role}
      {...props}
    />
  ),
);
TreeView.displayName = "TreeView";

export interface TreeGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  level?: number;
}

export const TreeGroup = React.forwardRef<HTMLDivElement, TreeGroupProps>(
  ({ className, level, role = "group", ...props }, ref) => (
    <div
      className={cn("asklake-tree-group", className)}
      data-level={level}
      ref={ref}
      role={role}
      {...props}
    />
  ),
);
TreeGroup.displayName = "TreeGroup";

export interface TreeRowProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    TreeRowStateProps {}

export const TreeRow = React.forwardRef<HTMLButtonElement, TreeRowProps>(
  (
    {
      className,
      expanded,
      leaf,
      level,
      role = "treeitem",
      selected,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      className={cn("asklake-tree-row", className)}
      ref={ref}
      role={role}
      type={type}
      {...treeRowStateProps({ expanded, leaf, level, selected })}
      {...props}
    />
  ),
);
TreeRow.displayName = "TreeRow";

export interface TreeStaticRowProps
  extends React.HTMLAttributes<HTMLDivElement>,
    TreeRowStateProps {}

export const TreeStaticRow = React.forwardRef<HTMLDivElement, TreeStaticRowProps>(
  ({ className, expanded, leaf, level, role = "treeitem", selected, ...props }, ref) => (
    <div
      className={cn("asklake-tree-row", className)}
      ref={ref}
      role={role}
      {...treeRowStateProps({ expanded, leaf, level, selected })}
      {...props}
    />
  ),
);
TreeStaticRow.displayName = "TreeStaticRow";
