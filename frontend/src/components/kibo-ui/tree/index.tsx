"use client";

import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type TreeContextType = {
  expandedIds: Set<string>;
  selectedIds: string[];
  toggleExpanded: (nodeId: string) => void;
  handleSelection: (nodeId: string, ctrlKey: boolean) => void;
  showLines?: boolean;
  showIcons?: boolean;
  selectable?: boolean;
  multiSelect?: boolean;
  indent?: number;
  animateExpand?: boolean;
};

const TreeContext = createContext<TreeContextType | undefined>(undefined);

const useTree = () => {
  const context = useContext(TreeContext);
  if (!context) {
    throw new Error("Tree components must be used within a TreeProvider");
  }
  return context;
};

type TreeNodeContextType = {
  nodeId: string;
  level: number;
  isLast: boolean;
  parentPath: boolean[];
};

const TreeNodeContext = createContext<TreeNodeContextType | undefined>(
  undefined
);

const useTreeNode = () => {
  const context = useContext(TreeNodeContext);
  if (!context) {
    throw new Error("TreeNode components must be used within a TreeNode");
  }
  return context;
};

export type TreeProviderProps = {
  children: ReactNode;
  defaultExpandedIds?: string[];
  expandedIds?: string[];
  onExpandedChange?: (expandedIds: string[], changedNodeId: string) => void;
  showLines?: boolean;
  showIcons?: boolean;
  selectable?: boolean;
  multiSelect?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  indent?: number;
  animateExpand?: boolean;
  className?: string;
};

export const TreeProvider = ({
  children,
  defaultExpandedIds = [],
  expandedIds: controlledExpandedIds,
  onExpandedChange,
  showLines = true,
  showIcons = true,
  selectable = true,
  multiSelect = false,
  selectedIds,
  onSelectionChange,
  indent = 20,
  animateExpand = true,
  className,
}: TreeProviderProps) => {
  const [internalExpandedIds, setInternalExpandedIds] = useState<Set<string>>(
    new Set(defaultExpandedIds)
  );
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>(
    selectedIds ?? []
  );

  const isControlled =
    selectedIds !== undefined && onSelectionChange !== undefined;
  const currentSelectedIds = isControlled ? selectedIds : internalSelectedIds;
  const isExpandedControlled =
    controlledExpandedIds !== undefined && onExpandedChange !== undefined;
  const expandedIds = useMemo(
    () =>
      isExpandedControlled
        ? new Set(controlledExpandedIds)
        : internalExpandedIds,
    [controlledExpandedIds, internalExpandedIds, isExpandedControlled]
  );

  const toggleExpanded = useCallback(
    (nodeId: string) => {
      const nextExpandedIds = new Set(expandedIds);
      if (nextExpandedIds.has(nodeId)) {
        nextExpandedIds.delete(nodeId);
      } else {
        nextExpandedIds.add(nodeId);
      }

      if (isExpandedControlled) {
        onExpandedChange?.(Array.from(nextExpandedIds), nodeId);
      } else {
        setInternalExpandedIds(nextExpandedIds);
      }
    },
    [expandedIds, isExpandedControlled, onExpandedChange]
  );

  const handleSelection = useCallback(
    (nodeId: string, ctrlKey = false) => {
      if (!selectable) {
        return;
      }

      let newSelection: string[];

      if (multiSelect && ctrlKey) {
        newSelection = currentSelectedIds.includes(nodeId)
          ? currentSelectedIds.filter((id) => id !== nodeId)
          : [...currentSelectedIds, nodeId];
      } else {
        newSelection = currentSelectedIds.includes(nodeId) ? [] : [nodeId];
      }

      if (isControlled) {
        onSelectionChange?.(newSelection);
      } else {
        setInternalSelectedIds(newSelection);
      }
    },
    [
      selectable,
      multiSelect,
      currentSelectedIds,
      isControlled,
      onSelectionChange,
    ]
  );

  return (
    <TreeContext.Provider
      value={{
        expandedIds,
        selectedIds: currentSelectedIds,
        toggleExpanded,
        handleSelection,
        showLines,
        showIcons,
        selectable,
        multiSelect,
        indent,
        animateExpand,
      }}
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={cn("w-full", className)}
        initial={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </TreeContext.Provider>
  );
};

export type TreeViewProps = HTMLAttributes<HTMLDivElement>;

export const TreeView = ({
  className,
  children,
  role = "tree",
  ...props
}: TreeViewProps) => (
  <div className={cn("p-2", className)} role={role} {...props}>
    {children}
  </div>
);

export type TreeNodeProps = HTMLAttributes<HTMLDivElement> & {
  nodeId?: string;
  level?: number;
  isLast?: boolean;
  parentPath?: boolean[];
  children?: ReactNode;
};

export const TreeNode = ({
  nodeId: providedNodeId,
  level = 0,
  isLast = false,
  parentPath = [],
  children,
  className,
  onClick,
  ...props
}: TreeNodeProps) => {
  const generatedId = useId();
  const nodeId = providedNodeId ?? generatedId;

  // Build the parent path - mark positions where the parent was the last child
  const currentPath = level === 0 ? [] : [...parentPath];
  if (level > 0 && parentPath.length < level - 1) {
    // Fill in missing levels with false (not last)
    while (currentPath.length < level - 1) {
      currentPath.push(false);
    }
  }
  if (level > 0) {
    currentPath[level - 1] = isLast;
  }

  return (
    <TreeNodeContext.Provider
      value={{
        nodeId,
        level,
        isLast,
        parentPath: currentPath,
      }}
    >
      <div className={cn("select-none", className)} {...props}>
        {children}
      </div>
    </TreeNodeContext.Provider>
  );
};

export type TreeNodeTriggerProps = ComponentProps<typeof motion.div>;

export const TreeNodeTrigger = ({
  children,
  className,
  onClick,
  onKeyDown,
  role = "treeitem",
  tabIndex = 0,
  ...props
}: TreeNodeTriggerProps) => {
  const { selectedIds, toggleExpanded, handleSelection, indent } = useTree();
  const { nodeId, level } = useTreeNode();
  const isSelected = selectedIds.includes(nodeId);

  return (
    <motion.div
      className={cn(
        "group relative mx-1 flex cursor-pointer items-center rounded-md px-3 py-2 text-slate-700 outline-none transition-[background-color,box-shadow] duration-200 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
        isSelected && "bg-blue-50 text-slate-950",
        className
      )}
      onClick={(e) => {
        toggleExpanded(nodeId);
        handleSelection(nodeId, e.ctrlKey || e.metaKey);
        onClick?.(e);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          (event.key !== "Enter" && event.key !== " ")
        ) {
          return;
        }
        event.preventDefault();
        toggleExpanded(nodeId);
        handleSelection(nodeId, event.ctrlKey || event.metaKey);
      }}
      role={role}
      style={{ paddingLeft: level * (indent ?? 0) + 8 }}
      tabIndex={tabIndex}
      whileTap={{ scale: 0.98, transition: { duration: 0.1 } }}
      {...props}
    >
      <TreeLines />
      {children as ReactNode}
    </motion.div>
  );
};

export const TreeLines = () => {
  const { showLines, indent } = useTree();
  const { level, isLast, parentPath } = useTreeNode();

  if (!showLines || level === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute top-0 bottom-0 left-0">
      {/* Render vertical lines for all parent levels */}
      {Array.from({ length: level }, (_, index) => {
        const shouldHideLine = parentPath[index] === true;
        if (shouldHideLine && index === level - 1) {
          return null;
        }

        return (
          <div
            className="absolute top-0 bottom-0 border-l border-slate-200"
            key={index.toString()}
            style={{
              left: index * (indent ?? 0) + 12,
              display: shouldHideLine ? "none" : "block",
            }}
          />
        );
      })}

      {/* Horizontal connector line */}
      <div
        className="absolute top-1/2 border-t border-slate-200"
        style={{
          left: (level - 1) * (indent ?? 0) + 12,
          width: (indent ?? 0) - 4,
          transform: "translateY(-1px)",
        }}
      />

      {/* Vertical line to midpoint for last items */}
      {isLast && (
        <div
          className="absolute top-0 border-l border-slate-200"
          style={{
            left: (level - 1) * (indent ?? 0) + 12,
            height: "50%",
          }}
        />
      )}
    </div>
  );
};

export type TreeNodeContentProps = ComponentProps<typeof motion.div> & {
  hasChildren?: boolean;
};

export const TreeNodeContent = ({
  children,
  hasChildren = false,
  className,
  ...props
}: TreeNodeContentProps) => {
  const { animateExpand, expandedIds } = useTree();
  const { nodeId } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  return (
    <AnimatePresence>
      {hasChildren && isExpanded && (
        <motion.div
          animate={{ height: "auto", opacity: 1 }}
          className="overflow-hidden"
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          transition={{
            duration: animateExpand ? 0.3 : 0,
            ease: "easeInOut",
          }}
        >
          <motion.div
            animate={{ y: 0 }}
            className={className}
            exit={{ y: -10 }}
            initial={{ y: -10 }}
            transition={{
              duration: animateExpand ? 0.2 : 0,
              delay: animateExpand ? 0.1 : 0,
            }}
            role="group"
            {...props}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export type TreeExpanderProps = ComponentProps<typeof motion.div> & {
  hasChildren?: boolean;
};

export const TreeExpander = ({
  hasChildren = false,
  className,
  onClick,
  ...props
}: TreeExpanderProps) => {
  const { expandedIds, toggleExpanded } = useTree();
  const { nodeId } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  if (!hasChildren) {
    return <div aria-hidden="true" className="mr-1 size-4" />;
  }

  return (
    <motion.div
      aria-hidden="true"
      animate={{ rotate: isExpanded ? 90 : 0 }}
      className={cn(
        "mr-1 flex size-4 cursor-pointer items-center justify-center",
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        toggleExpanded(nodeId);
        onClick?.(e);
      }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      {...props}
    >
      <ChevronRight className="size-3 text-slate-500" />
    </motion.div>
  );
};

export type TreeIconProps = ComponentProps<typeof motion.div> & {
  icon?: ReactNode;
  hasChildren?: boolean;
};

export const TreeIcon = ({
  icon,
  hasChildren = false,
  className,
  ...props
}: TreeIconProps) => {
  const { showIcons, expandedIds } = useTree();
  const { nodeId } = useTreeNode();
  const isExpanded = expandedIds.has(nodeId);

  if (!showIcons) {
    return null;
  }

  const getDefaultIcon = () =>
    hasChildren ? (
      isExpanded ? (
        <FolderOpen className="size-4" />
      ) : (
        <Folder className="size-4" />
      )
    ) : (
      <FileText className="size-4" />
    );

  return (
    <motion.div
      className={cn(
        "mr-2 flex size-4 items-center justify-center text-slate-500 [&_svg]:size-4",
        className
      )}
      transition={{ duration: 0.15 }}
      whileHover={{ scale: 1.1 }}
      aria-hidden="true"
      {...props}
    >
      {icon || getDefaultIcon()}
    </motion.div>
  );
};

export type TreeLabelProps = HTMLAttributes<HTMLSpanElement>;

export const TreeLabel = ({ className, ...props }: TreeLabelProps) => (
  <span
    className={cn("flex-1 truncate text-sm font-semibold", className)}
    {...props}
  />
);
