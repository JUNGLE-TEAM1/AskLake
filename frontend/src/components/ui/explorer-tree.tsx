import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ForwardedRef,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { CheckCircle2, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from "react-arborist";

import { cn } from "@/lib/utils";

export type ExplorerTreeNode = {
  children?: ExplorerTreeNode[];
  disabled?: boolean;
  id: string;
  label: string;
  meta?: ReactNode;
  selectable?: boolean;
  selected?: boolean;
};

type ExplorerTreeRowProps<T extends ExplorerTreeNode> = {
  getIcon?: (node: NodeApi<T>) => ReactNode;
  getLabel?: (node: NodeApi<T>) => ReactNode;
  getRowClassName?: (node: NodeApi<T>) => string | undefined;
  getRowProps?: (node: NodeApi<T>) => Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "style">;
  getTrailing?: (node: NodeApi<T>) => ReactNode;
  indent: number;
  node: NodeApi<T>;
  onNodePress?: (node: NodeApi<T>) => void;
  style: CSSProperties;
  toggleOnRowPress: boolean;
};

type TreePredicate<T> = (data: T) => boolean;

export type ExplorerTreeProps<T extends ExplorerTreeNode> = {
  ariaLabel: string;
  className?: string;
  data?: readonly T[];
  defaultHeight?: number;
  disableDeselectOnClick?: boolean;
  disableDrag?: boolean | string | TreePredicate<T>;
  disableDrop?: boolean | string | ((args: {
    dragNodes: NodeApi<T>[];
    index: number;
    parentNode: NodeApi<T>;
  }) => boolean);
  disableEdit?: boolean | string | TreePredicate<T>;
  disableMultiSelection?: boolean;
  disableSelect?: boolean | string | TreePredicate<T>;
  getIcon?: (node: NodeApi<T>) => ReactNode;
  getLabel?: (node: NodeApi<T>) => ReactNode;
  getRowClassName?: (node: NodeApi<T>) => string | undefined;
  getRowProps?: (node: NodeApi<T>) => Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "style">;
  getTrailing?: (node: NodeApi<T>) => ReactNode;
  initialData?: readonly T[];
  initialOpenState?: Record<string, boolean>;
  indent?: number;
  minHeight?: number;
  onActivate?: (node: NodeApi<T>) => void;
  onClick?: MouseEventHandler;
  onFocus?: (node: NodeApi<T>) => void;
  onNodePress?: (node: NodeApi<T>) => void;
  onSelect?: (nodes: NodeApi<T>[]) => void;
  onToggle?: (id: string) => void;
  openByDefault?: boolean;
  overscanCount?: number;
  rowHeight?: number | ((node: NodeApi<T>) => number);
  rowClassName?: string;
  searchMatch?: (node: NodeApi<T>, searchTerm: string) => boolean;
  searchTerm?: string;
  selection?: string;
  selectionFollowsFocus?: boolean;
  toggleOnRowPress?: boolean;
  treeRef?: ForwardedRef<TreeApi<T> | undefined>;
};

export function ExplorerTree<T extends ExplorerTreeNode>({
  ariaLabel,
  className,
  defaultHeight = 320,
  getIcon,
  getLabel,
  getRowClassName,
  getRowProps,
  getTrailing,
  indent = 18,
  minHeight = 160,
  onNodePress,
  rowHeight = 40,
  rowClassName,
  toggleOnRowPress = true,
  treeRef,
  ...treeProps
}: ExplorerTreeProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(defaultHeight);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateHeight = () => {
      const nextHeight = Math.floor(viewport.getBoundingClientRect().height);
      if (nextHeight > 0) setHeight(Math.max(minHeight, nextHeight));
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [minHeight]);

  const NodeRenderer = useCallback(
    ({ node, style }: NodeRendererProps<T>) => (
      <ExplorerTreeRow
        getIcon={getIcon}
        getLabel={getLabel}
        getRowClassName={getRowClassName}
        getRowProps={getRowProps}
        getTrailing={getTrailing}
        indent={indent}
        node={node}
        onNodePress={onNodePress}
        style={style}
        toggleOnRowPress={toggleOnRowPress}
      />
    ),
    [getIcon, getLabel, getRowClassName, getRowProps, getTrailing, indent, onNodePress, toggleOnRowPress],
  );

  return (
    <div ref={viewportRef} className={cn("min-h-0 min-w-0 overflow-hidden", className)}>
      <Tree<T>
        ref={treeRef}
        {...treeProps}
        aria-label={ariaLabel}
        className="asklake-explorer-tree"
        disableDrag={treeProps.disableDrag ?? true}
        disableDrop={treeProps.disableDrop ?? true}
        disableEdit={treeProps.disableEdit ?? true}
        height={height}
        indent={indent}
        overscanCount={treeProps.overscanCount ?? 8}
        rowHeight={rowHeight}
        rowClassName={cn("asklake-explorer-tree-row", rowClassName)}
        width="100%"
      >
        {NodeRenderer}
      </Tree>
    </div>
  );
}

function ExplorerTreeRow<T extends ExplorerTreeNode>({
  getIcon,
  getLabel,
  getRowClassName,
  getRowProps,
  getTrailing,
  indent,
  node,
  onNodePress,
  style,
  toggleOnRowPress,
}: ExplorerTreeRowProps<T>) {
  const rowProps = getRowProps?.(node);
  const isSelected = node.isSelected || Boolean(node.data.selected);
  const icon = getIcon?.(node) ?? (
    node.isInternal
      ? node.isOpen
        ? <FolderOpen />
        : <Folder />
      : <FileText />
  );

  return (
    <div className="box-border h-full px-1" style={style}>
      <div
        data-selected={isSelected ? "" : undefined}
        className={cn(
          "asklake-explorer-tree-row-content group relative flex h-full w-full min-w-0 items-center rounded-sm pr-2 text-[15px] font-semibold text-slate-700 transition-colors",
          "hover:bg-slate-50",
          isSelected && "bg-blue-50 text-blue-950",
          node.data.disabled && "cursor-not-allowed opacity-50",
          getRowClassName?.(node),
        )}
        style={{ paddingLeft: 8 }}
      >
        <button
          aria-label={node.isInternal ? `${node.data.label} ${node.isOpen ? "접기" : "펼치기"}` : undefined}
          className={cn(
            "mr-1 flex size-5 shrink-0 items-center justify-center rounded text-slate-500 outline-none transition-transform focus-visible:ring-2 focus-visible:ring-blue-500/40",
            !node.isInternal && "pointer-events-none invisible",
            node.isInternal && node.isOpen && "rotate-90 text-blue-600",
          )}
          disabled={!node.isInternal || node.data.disabled}
          tabIndex={node.isInternal ? 0 : -1}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
        >
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </button>
        <button
          {...rowProps}
          aria-expanded={node.isInternal ? node.isOpen : undefined}
          aria-selected={isSelected || undefined}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center bg-transparent text-left outline-none",
            rowProps?.className,
          )}
          disabled={node.data.disabled || rowProps?.disabled}
          type="button"
          onClick={(event) => {
            rowProps?.onClick?.(event);
            if (event.defaultPrevented || node.data.disabled) return;
            if (toggleOnRowPress && node.isInternal) node.toggle();
            node.handleClick(event);
            onNodePress?.(node);
          }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "mr-2 flex size-4 shrink-0 items-center justify-center text-slate-500 [&_svg]:size-4",
              isSelected && "text-blue-600",
            )}
          >
            {isSelected ? <CheckCircle2 className="fill-blue-50 text-blue-600" /> : icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{getLabel?.(node) ?? node.data.label}</span>
          {node.data.meta ? (
            <span className="ml-2 min-w-0 max-w-36 shrink truncate text-xs font-semibold text-slate-500">
              {node.data.meta}
            </span>
          ) : null}
          {getTrailing ? <span className="ml-2 flex shrink-0 items-center">{getTrailing(node)}</span> : null}
        </button>
      </div>
    </div>
  );
}
