import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Loader2 } from "lucide-react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { TreePanel } from "@/components/ui/tree-panel";
import { cn } from "@/lib/utils";

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(320);
  const loadedFolderPathSet = useMemo(
    () => new Set(loadedFolderPaths ?? []),
    [loadedFolderPaths],
  );
  const selectedNodeId = selectedPath ? `file:${selectedPath}` : undefined;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateHeight = () => {
      setTreeHeight(Math.max(260, Math.floor(viewport.getBoundingClientRect().height)));
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

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

  const SourceTreeNode = useCallback(({ node, style }: NodeRendererProps<SourceAssetTreeNode>) => {
    const asset = node.data;
    const isLoading = asset.isFolder && asset.path === loadingPath;
    const folderMeta = isLoading
      ? LABELS.loading
      : asset.children.length > 0
        ? `${asset.children.length}개`
        : LABELS.open;

    return (
      <div className="source-arborist-row-wrap" style={style}>
        <button
          aria-expanded={asset.isFolder ? node.isOpen : undefined}
          className={cn(
            "source-arborist-row",
            asset.isFolder && "is-folder",
            node.isOpen && "is-open",
            node.isSelected && "is-selected",
          )}
          title={asset.path}
          type="button"
          onClick={() => {
            if (asset.isFolder) {
              node.toggle();
              return;
            }
            void onSelect(asset.path);
          }}
        >
          <span className="source-arborist-expander" aria-hidden="true">
            {asset.isFolder ? <ChevronRight size={15} strokeWidth={2.2} /> : null}
          </span>
          {asset.isFolder ? (
            node.isOpen ? <FolderOpen className="source-arborist-icon folder" size={16} /> : <Folder className="source-arborist-icon folder" size={16} />
          ) : (
            <FileText className="source-arborist-icon file" size={16} />
          )}
          <strong className="source-arborist-name">{asset.name}</strong>
          <span className="source-arborist-meta">
            {isLoading ? <Loader2 className="source-arborist-loading" size={13} /> : null}
            {asset.isFolder ? folderMeta : asset.meta}
          </span>
        </button>
      </div>
    );
  }, [loadingPath, onSelect]);

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
      <div ref={viewportRef} className="source-asset-tree-viewport">
        <Tree<SourceAssetTreeNode>
          aria-label="소스 에셋 트리"
          className="source-arborist-tree"
          data={nodes}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          disableSelect={(asset) => asset.isFolder}
          height={treeHeight}
          indent={18}
          openByDefault={false}
          overscanCount={8}
          rowHeight={40}
          selection={selectedNodeId}
          width="100%"
          onSelect={(selectedNodes) => {
            const asset = selectedNodes.find((selectedNode) => !selectedNode.data.isFolder)?.data;
            if (asset) void onSelect(asset.path);
          }}
          onToggle={(nodeId) => {
            const asset = nodeById.get(nodeId);
            if (asset?.isFolder) requestFolderChildren(asset);
          }}
        >
          {SourceTreeNode}
        </Tree>
      </div>
    </TreePanel>
  );
}

function buildSourceAssetTree(assets: SourceAsset[]) {
  const root: SourceAssetTreeNode = {
    children: [],
    id: "root",
    isFolder: true,
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
    node.children.forEach((child) => {
      nodeById.set(child.id, child);
      sortTree(child);
    });
  };
  sortTree(root);

  return { nodeById, nodes: root.children };
}
