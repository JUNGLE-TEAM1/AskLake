import { useCallback, useMemo, useRef } from "react";
import { FileText, Folder, FolderOpen, Loader2 } from "lucide-react";
import type { NodeApi } from "react-arborist";
import { ExplorerTree } from "@/components/ui/explorer-tree";
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
  children: SourceAssetTreeNode[];
  id: string;
  isFolder: boolean;
  label: string;
  meta: string;
  name: string;
  path: string;
  status: string;
};

const LABELS = {
  empty: "표시할 소스 항목이 없습니다.",
  loading: "불러오는 중",
  open: "열기",
};

export function SourceAssetTree({
  assets,
  loadedFolderPaths,
  loadingPath = "",
  selectedPath,
  onOpenFolder,
  onSelect,
}: SourceAssetTreeProps) {
  const { nodeById, nodes } = useMemo(() => buildSourceAssetTree(assets), [assets]);
  const requestedFolderPaths = useRef(new Set<string>());
  const loadedFolderPathSet = useMemo(
    () => new Set(loadedFolderPaths ?? []),
    [loadedFolderPaths],
  );
  const selectedNodeId = selectedPath
    ? (nodeById.has(`file:${selectedPath}`) ? `file:${selectedPath}` : `folder:${selectedPath}`)
    : undefined;

  const requestFolderChildren = useCallback((node: SourceAssetTreeNode) => {
    if (!onOpenFolder) return;
    if (node.path === loadingPath) return;
    if (loadedFolderPathSet.has(node.path)) return;
    if (requestedFolderPaths.current.has(node.path)) return;

    requestedFolderPaths.current.add(node.path);
    void Promise.resolve(onOpenFolder(node.path)).catch(() => {
      requestedFolderPaths.current.delete(node.path);
    });
  }, [loadedFolderPathSet, loadingPath, onOpenFolder]);

  const toggleFolder = useCallback((node: SourceAssetTreeNode) => {
    requestFolderChildren(node);
    void onSelect(node.path);
  }, [onSelect, requestFolderChildren]);

  const selectSourceNode = useCallback((node: SourceAssetTreeNode) => {
    if (node.isFolder) {
      toggleFolder(node);
      return;
    }
    void onSelect(node.path);
  }, [onSelect, toggleFolder]);

  const getIcon = useCallback((node: NodeApi<SourceAssetTreeNode>) => {
    if (!node.data.isFolder) return <FileText className="text-indigo-500" />;
    return node.isOpen ? <FolderOpen className="text-blue-600" /> : <Folder className="text-blue-600" />;
  }, []);

  const getTrailing = useCallback((node: NodeApi<SourceAssetTreeNode>) => (
    <>
      {node.data.isFolder ? (
        folderSelectionControl(node.data, onSelect)
      ) : null}
      {node.data.path === loadingPath
        ? <Loader2 className="size-3.5 animate-spin text-blue-600" />
        : null}
    </>
  ), [loadingPath, onSelect]);

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
      <ExplorerTree<SourceAssetTreeNode>
        ariaLabel="소스 에셋 트리"
        className="h-full min-w-0"
        data={nodes}
        disableMultiSelection
        getIcon={getIcon}
        getRowProps={(node) => ({ title: node.data.path })}
        getTrailing={getTrailing}
        minHeight={260}
        openByDefault={false}
        selection={selectedNodeId}
        onNodePress={(node) => {
          selectSourceNode(node.data);
        }}
        onToggle={(nodeId) => {
          const asset = nodeById.get(nodeId);
          if (asset?.isFolder) requestFolderChildren(asset);
        }}
      />
    </TreePanel>
  );
}

function folderSelectionControl(node: SourceAssetTreeNode, onSelect: (assetPath: string) => void | Promise<void>) {
  return (
    <button
      type="button"
      aria-label={`폴더 ${node.name} 선택`}
      className="source-asset-folder-select"
      title="이 폴더를 증분 수집 범위로 선택"
      onClick={(event) => {
        event.stopPropagation();
        void onSelect(node.path);
      }}
    />
  );
}

function buildSourceAssetTree(assets: SourceAsset[]) {
  const root: SourceAssetTreeNode = {
    children: [],
    id: "root",
    isFolder: true,
    label: "root",
    meta: "folder",
    name: "root",
    path: "",
    status: "",
  };
  const childMaps = new Map<string, Map<string, SourceAssetTreeNode>>([[root.id, new Map()]]);

  const ensureChild = (parent: SourceAssetTreeNode, name: string, path: string, isFolder: boolean) => {
    const id = `${isFolder ? "folder" : "file"}:${path || name}`;
    const childMap = childMaps.get(parent.id) ?? new Map<string, SourceAssetTreeNode>();
    childMaps.set(parent.id, childMap);
    const existing = childMap.get(id);
    if (existing) {
      if (isFolder) existing.isFolder = true;
      return existing;
    }

    const node: SourceAssetTreeNode = {
      children: [],
      id,
      isFolder,
      label: name,
      meta: isFolder ? "folder" : "file",
      name,
      path,
      status: "",
    };
    childMap.set(id, node);
    childMaps.set(id, new Map());
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
      const segmentPath = `${segments.slice(0, segmentIndex + 1).join("/")}${!isLast || isFolderAsset ? "/" : ""}`;
      current = ensureChild(current, segment, segmentPath, !isLast || isFolderAsset);
      if (isLast) {
        current.assetIndex = assetIndex;
        current.isFolder = isFolderAsset || current.children.length > 0;
        current.meta = meta;
        current.status = status;
      }
    });
  });

  const nodeById = new Map<string, SourceAssetTreeNode>();
  const sortTree = (node: SourceAssetTreeNode) => {
    node.children.sort((left, right) => {
      if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    if (node.isFolder && node.id !== "root") {
      node.meta = node.children.length > 0 ? `${node.children.length}개` : LABELS.open;
    }
    node.children.forEach((child) => {
      nodeById.set(child.id, child);
      sortTree(child);
    });
  };
  sortTree(root);

  return { nodeById, nodes: root.children };
}
