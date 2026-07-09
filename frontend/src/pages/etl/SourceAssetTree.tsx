import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { TreePanel } from "@/components/ui/tree-panel";

export type SourceAsset = [path: string, meta: string, status: string];

type SourceAssetTreeProps = {
  assets: SourceAsset[];
  /** Folder paths the parent already fetched, including empty folders. */
  loadedFolderPaths?: readonly string[];
  loadingPath?: string;
  selectedPath: string;
  onOpenFolder?: (folderPath: string) => void | Promise<void>;
  onSelect: (assetPath: string) => void | Promise<void>;
};

type SourceAssetTreeNode = {
  assetIndex?: number;
  childMap: Map<string, SourceAssetTreeNode>;
  children: SourceAssetTreeNode[];
  id: string;
  isFolder: boolean;
  meta: string;
  name: string;
  path: string;
  status: string;
};

const LABELS = {
  empty: "\uD45C\uC2DC\uD560 \uC18C\uC2A4 \uD56D\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
  file: "\uD30C\uC77C",
  folder: "\uD3F4\uB354",
  loading: "\uBD88\uB7EC\uC624\uB294 \uC911",
  open: "\uC5F4\uAE30",
};

const TREE_VIEW_SX = {
  overflowX: "hidden",
  "& .MuiTreeItem-content": {
    boxSizing: "border-box",
    minWidth: 0,
    width: "100%",
  },
  "& .MuiTreeItem-label": {
    minWidth: 0,
    width: "100%",
  },
};

const TREE_LABEL_STYLE: React.CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: "0.375rem",
  gridTemplateColumns: "1rem auto minmax(0, 1fr) auto",
  minWidth: 0,
  width: "100%",
};

const TREE_NAME_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const TREE_META_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  whiteSpace: "nowrap",
};

const TREE_FIXED_ITEM_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
};

export function SourceAssetTree({
  assets,
  loadedFolderPaths,
  loadingPath = "",
  selectedPath,
  onOpenFolder,
  onSelect,
}: SourceAssetTreeProps) {
  const { nodeById, nodeIds, nodes } = useMemo(() => buildSourceAssetTree(assets), [assets]);
  const nodeIdsKey = nodeIds.join("\0");
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const requestedFolderPaths = useRef(new Set<string>());
  const loadedFolderPathSet = useMemo(
    () => new Set(loadedFolderPaths ?? []),
    [loadedFolderPaths],
  );

  useEffect(() => {
    const availableNodeIds = new Set(nodeIds);
    setExpandedItems((current) => current.filter((itemId) => availableNodeIds.has(itemId)));
  }, [nodeIdsKey]);

  const requestFolderChildren = (node: SourceAssetTreeNode) => {
    if (!onOpenFolder) return;
    if (node.path === loadingPath) return;
    if (loadedFolderPathSet.has(node.path)) return;
    if (requestedFolderPaths.current.has(node.path)) return;

    requestedFolderPaths.current.add(node.path);
    void Promise.resolve(onOpenFolder(node.path)).catch(() => {
      requestedFolderPaths.current.delete(node.path);
    });
  };

  const updateExpandedItems = (itemIds: string[]) => {
    const currentlyExpanded = new Set(expandedItems);
    itemIds.forEach((itemId) => {
      if (currentlyExpanded.has(itemId)) return;
      const node = nodeById.get(itemId);
      if (node?.isFolder) requestFolderChildren(node);
    });
    setExpandedItems(itemIds);
  };

  const toggleFolder = (node: SourceAssetTreeNode) => {
    const isOpen = expandedItems.includes(node.id);
    if (!isOpen) {
      requestFolderChildren(node);
    }
    setExpandedItems((current) => (
      current.includes(node.id)
        ? current.filter((itemId) => itemId !== node.id)
        : [...current, node.id]
    ));
  };

  const renderNode = (node: SourceAssetTreeNode): React.ReactNode => {
    const canSelectFile = !node.isFolder && typeof node.assetIndex === "number";
    const isSelected = canSelectFile && node.path === selectedPath;
    const isExpanded = expandedItems.includes(node.id);
    const folderMeta = node.path === loadingPath
      ? LABELS.loading
      : node.children.length > 0
        ? `${node.children.length}\uAC1C`
        : LABELS.open;

    const label = (
      <div
        className={isSelected ? "source-asset-tree-label active" : "source-asset-tree-label"}
        role="button"
        style={TREE_LABEL_STYLE}
        tabIndex={0}
        title={node.path}
        onClick={(event) => {
          event.stopPropagation();
          if (node.isFolder) {
            toggleFolder(node);
            return;
          }
          if (canSelectFile) {
            void onSelect(node.path);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (node.isFolder) {
            toggleFolder(node);
            return;
          }
          if (canSelectFile) {
            void onSelect(node.path);
          }
        }}
      >
        <span
          className={node.isFolder ? "source-asset-disclosure folder" : "source-asset-disclosure"}
          style={TREE_FIXED_ITEM_STYLE}
          aria-hidden="true"
        >
          {node.isFolder ? (isExpanded ? "v" : ">") : ""}
        </span>
        <span
          className={node.isFolder ? "source-asset-kind folder" : "source-asset-kind file"}
          style={TREE_FIXED_ITEM_STYLE}
        >
          {node.isFolder ? LABELS.folder : LABELS.file}
        </span>
        <strong style={TREE_NAME_STYLE}>{node.name}</strong>
        <em style={TREE_META_STYLE}>{node.isFolder ? folderMeta : node.meta}</em>
      </div>
    );

    return (
      <TreeItem key={node.id} itemId={node.id} label={label}>
        {isExpanded ? node.children.map(renderNode) : null}
      </TreeItem>
    );
  };

  if (nodes.length === 0) {
    return (
      <TreePanel
        className="source-asset-tree-panel"
        emptyState={<p className="source-empty-note">{LABELS.empty}</p>}
        isEmpty
      />
    );
  }

  return (
    <TreePanel className="source-asset-tree-panel">
      <SimpleTreeView
        className="source-asset-tree"
        expandedItems={expandedItems}
        sx={TREE_VIEW_SX}
        onExpandedItemsChange={(_, itemIds) => updateExpandedItems(itemIds)}
      >
        {nodes.map(renderNode)}
      </SimpleTreeView>
    </TreePanel>
  );
}

function buildSourceAssetTree(assets: SourceAsset[]) {
  const root: SourceAssetTreeNode = {
    childMap: new Map(),
    children: [],
    id: "root",
    isFolder: true,
    meta: "folder",
    name: "root",
    path: "",
    status: "",
  };

  const ensureChild = (parent: SourceAssetTreeNode, name: string, path: string, isFolder: boolean) => {
    const id = `${isFolder ? "folder" : "file"}:${path || name}`;
    const existing = parent.childMap.get(id);
    if (existing) {
      if (isFolder) existing.isFolder = true;
      return existing;
    }

    const node: SourceAssetTreeNode = {
      childMap: new Map(),
      children: [],
      id,
      isFolder,
      meta: isFolder ? "folder" : "file",
      name,
      path,
      status: "",
    };
    parent.childMap.set(id, node);
    parent.children.push(node);
    return node;
  };

  assets.forEach(([rawPath, meta, status], assetIndex) => {
    const isFolderAsset = meta.toLowerCase() === "folder" || rawPath.endsWith("/");
    const cleanPath = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = cleanPath.split("/").filter(Boolean);
    if (segments.length === 0) return;

    let current = root;
    segments.forEach((segment, segmentIndex) => {
      const isLast = segmentIndex === segments.length - 1;
      const segmentPath = segments.slice(0, segmentIndex + 1).join("/") + (!isLast || isFolderAsset ? "/" : "");
      current = ensureChild(current, segment, segmentPath, !isLast || isFolderAsset);
      if (isLast) {
        current.assetIndex = assetIndex;
        current.isFolder = isFolderAsset || current.children.length > 0;
        current.meta = meta;
        current.status = status;
      }
    });
  });

  const sortTree = (node: SourceAssetTreeNode) => {
    node.children.sort((left, right) => {
      if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortTree);
  };
  sortTree(root);

  const nodeById = new Map<string, SourceAssetTreeNode>();
  const nodeIds: string[] = [];
  const collectNodeIds = (node: SourceAssetTreeNode) => {
    if (node.id !== "root") {
      nodeById.set(node.id, node);
      nodeIds.push(node.id);
    }
    node.children.forEach(collectNodeIds);
  };
  collectNodeIds(root);

  return { nodeById, nodeIds, nodes: root.children };
}
