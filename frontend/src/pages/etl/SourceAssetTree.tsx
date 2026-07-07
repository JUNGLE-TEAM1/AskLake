import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";

export type SourceAsset = [path: string, meta: string, status: string];

type SourceAssetTreeProps = {
  assets: SourceAsset[];
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

export function SourceAssetTree({ assets, selectedPath, onOpenFolder, onSelect }: SourceAssetTreeProps) {
  const { nodeIds, nodes } = useMemo(() => buildSourceAssetTree(assets), [assets]);
  const nodeIdsKey = nodeIds.join("\0");
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  useEffect(() => {
    const availableNodeIds = new Set(nodeIds);
    setExpandedItems((current) => current.filter((itemId) => availableNodeIds.has(itemId)));
  }, [nodeIdsKey]);

  const toggleFolder = (node: SourceAssetTreeNode) => {
    const isOpen = expandedItems.includes(node.id);
    if (!isOpen) {
      void onOpenFolder?.(node.path);
    }
    setExpandedItems((current) => {
      if (current.includes(node.id)) {
        return current.filter((itemId) => itemId !== node.id);
      }
      return [...current, node.id];
    });
  };

  const renderNode = (node: SourceAssetTreeNode): React.ReactNode => {
    const canOpenFolder = node.isFolder;
    const canSelectFile = !node.isFolder && typeof node.assetIndex === "number";
    const isSelected = canSelectFile && node.path === selectedPath;
    const isExpanded = expandedItems.includes(node.id);
    const label = (
      <div
        className={isSelected ? "source-asset-tree-label active" : "source-asset-tree-label"}
        role={canOpenFolder || canSelectFile ? "button" : undefined}
        tabIndex={canOpenFolder || canSelectFile ? 0 : -1}
        title={node.path}
        onClick={(event) => {
          event.stopPropagation();
          if (canOpenFolder) {
            toggleFolder(node);
            return;
          }
          if (!canSelectFile) return;
          void onSelect(node.path);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (canOpenFolder) {
            toggleFolder(node);
            return;
          }
          if (!canSelectFile) return;
          void onSelect(node.path);
        }}
      >
        <span className={node.isFolder ? "source-asset-disclosure folder" : "source-asset-disclosure"} aria-hidden="true">
          {node.isFolder ? (isExpanded ? "v" : ">") : ""}
        </span>
        <span className={node.isFolder ? "source-asset-kind folder" : "source-asset-kind file"}>
          {node.isFolder ? "DIR" : "FILE"}
        </span>
        <strong>{node.name}</strong>
        <em>{node.isFolder ? `${node.children.length} items` : node.meta}</em>
      </div>
    );

    return (
      <TreeItem key={node.id} itemId={node.id} label={label}>
        {isExpanded ? node.children.map(renderNode) : null}
      </TreeItem>
    );
  };

  if (nodes.length === 0) {
    return <p className="source-empty-note">No source assets to display.</p>;
  }

  return (
    <SimpleTreeView
      className="source-asset-tree"
      expandedItems={expandedItems}
      onExpandedItemsChange={(_, itemIds) => setExpandedItems(itemIds)}
    >
      {nodes.map(renderNode)}
    </SimpleTreeView>
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
    const id = path || name;
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
    const cleanPath = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = cleanPath.split("/").filter(Boolean);
    if (segments.length === 0) return;

    const isFolderAsset = meta.toLowerCase() === "folder" || rawPath.endsWith("/");
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

  const nodeIds: string[] = [];
  const collectNodeIds = (node: SourceAssetTreeNode) => {
    if (node.id !== "root") {
      nodeIds.push(node.id);
    }
    node.children.forEach(collectNodeIds);
  };
  collectNodeIds(root);

  return { nodeIds, nodes: root.children };
}
