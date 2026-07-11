import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Check } from "lucide-react";
import { TreePanel } from "@/components/ui/tree-panel";
import { TreeGroup, TreeRow, TreeView } from "@/components/ui/tree-view";

export type SourceAsset = [path: string, meta: string, status: string];

type SourceAssetTreeProps = {
  assets: SourceAsset[];
  /** Folder paths the parent already fetched, including empty folders. */
  loadedFolderPaths?: readonly string[];
  loadingPath?: string;
  selectedPath: string;
  onOpenFolder?: (folderPath: string) => void | Promise<unknown>;
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

export function SourceAssetTree({
  assets,
  loadedFolderPaths,
  loadingPath = "",
  selectedPath,
  onOpenFolder,
  onSelect,
}: SourceAssetTreeProps) {
  const { nodeIds, nodes } = useMemo(() => buildSourceAssetTree(assets), [assets]);
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

  const toggleFolder = (node: SourceAssetTreeNode, requestChildren = true) => {
    const isOpen = expandedItems.includes(node.id);
    if (!isOpen && requestChildren) {
      requestFolderChildren(node);
    }
    setExpandedItems((current) => (
      current.includes(node.id)
        ? current.filter((itemId) => itemId !== node.id)
        : [...current, node.id]
    ));
  };

  const renderNode = (node: SourceAssetTreeNode, depth = 0): React.ReactNode => {
    const canSelect = node.isFolder || typeof node.assetIndex === "number";
    const isSelected = canSelect && node.path === selectedPath;
    const isExpanded = expandedItems.includes(node.id);
    const folderMeta = node.path === loadingPath
      ? LABELS.loading
      : node.children.length > 0
        ? `${node.children.length}\uAC1C`
        : LABELS.open;

    return (
      <div className="source-asset-tree-item" key={node.id}>
        <div className={`source-asset-tree-row-shell ${node.isFolder ? "folder" : "file"}`}>
          <TreeRow
            aria-expanded={node.isFolder ? isExpanded : undefined}
            className={isSelected ? "source-asset-tree-label active" : "source-asset-tree-label"}
            expanded={node.isFolder ? isExpanded : undefined}
            leaf={!node.isFolder}
            level={depth}
            selected={isSelected}
            title={node.path}
            onClick={(event) => {
              event.stopPropagation();
              if (node.isFolder) {
                toggleFolder(node);
                return;
              }
              if (canSelect) void onSelect(node.path);
            }}
          >
            <span
              className={node.isFolder ? "source-asset-disclosure folder" : "source-asset-disclosure"}
              aria-hidden="true"
            >
              {node.isFolder ? (isExpanded ? "v" : ">") : ""}
            </span>
            <span className={node.isFolder ? "source-asset-kind folder" : "source-asset-kind file"}>
              {node.isFolder ? LABELS.folder : LABELS.file}
            </span>
            <strong>{node.name}</strong>
            <em>{node.isFolder ? folderMeta : node.meta}</em>
          </TreeRow>
          {node.isFolder && canSelect ? (
            <button
              aria-label={`폴더 ${node.name} 선택`}
              className={isSelected ? "source-asset-folder-select active" : "source-asset-folder-select"}
              title="이 폴더를 수집 범위로 선택"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onSelect(node.path);
              }}
            >
              <Check size={15} />
            </button>
          ) : null}
        </div>
        {node.isFolder && isExpanded ? (
          <TreeGroup className="source-asset-tree-group" level={depth + 1}>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </TreeGroup>
        ) : null}
      </div>
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
      <TreeView
        className="source-asset-tree"
        label="소스 에셋 트리"
      >
        {nodes.map((node) => renderNode(node))}
      </TreeView>
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
