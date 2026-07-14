import { useEffect, useMemo, useState } from "react";
import { Check, Clipboard, Folder, FolderOpen, FolderSearch, Loader2, MoreHorizontal, RefreshCw, Search } from "lucide-react";
import type { NodeApi } from "react-arborist";
import { Button } from "@/components/ui/button";
import { ExplorerTree, type ExplorerTreeNode } from "@/components/ui/explorer-tree";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect } from "@/components/ui/native-select";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { TreePanel } from "@/components/ui/tree-panel";
import { listS3Buckets, listS3Prefixes, type S3PrefixesResponse, type S3PrefixFolder } from "../../services/s3PathApi";
import { buildS3Path, normalizePrefix, parseS3Path, S3_SCHEME } from "../../utils/s3Path";

type S3PathFieldProps = {
  disabled?: boolean;
  onChange: (path: string) => void;
  useShadcnStyles?: boolean;
  value: string;
};

type ListingState = {
  data?: S3PrefixesResponse;
  error?: string;
  loading?: boolean;
};

type S3TreeNode = ExplorerTreeNode & {
  children?: S3TreeNode[];
  continuationToken?: string | null;
  kind: "empty" | "error" | "folder" | "loading" | "more";
  prefix: string;
};

const ROOT_PREFIX_ID = "__root__";

function listingKey(bucket: string, prefix: string) {
  return `${bucket}::${normalizePrefix(prefix)}`;
}

function prefixToItemId(prefix: string) {
  return prefix ? `prefix:${prefix}` : ROOT_PREFIX_ID;
}

function hasVisibleMatch(folder: S3PrefixFolder, query: string) {
  if (!query) return true;
  const normalizedQuery = query.trim().toLowerCase();
  return folder.name.toLowerCase().includes(normalizedQuery) || folder.prefix.toLowerCase().includes(normalizedQuery);
}

function S3PathText({ value }: { value: string }) {
  const parsed = useMemo(() => parseS3Path(value), [value]);

  if (!parsed.bucket) {
    return <span className="s3-path-empty">S3 경로를 선택하세요</span>;
  }

  return <span className="s3-path-text" title={parsed.path}>{parsed.path}</span>;
}

export function S3PathField({ disabled = false, onChange, useShadcnStyles = false, value }: S3PathFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const parsed = useMemo(() => parseS3Path(value), [value]);

  const copyPath = async () => {
    if (!value.trim()) return;
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="s3-path-field">
      <div className="s3-path-display" title={parsed.path || value}>
        <S3PathText value={value} />
      </div>
      <Button className={useShadcnStyles ? undefined : "secondary-button s3-path-action"} disabled={disabled} type="button" variant="outline" onClick={() => setPickerOpen(true)}>
        <FolderSearch data-icon="inline-start" />
        찾아보기
      </Button>
      <Button className={useShadcnStyles ? undefined : "secondary-button s3-path-action"} disabled={disabled || !value.trim()} type="button" variant="outline" onClick={copyPath}>
        {copied ? <Check data-icon="inline-start" /> : <Clipboard data-icon="inline-start" />}
        {copied ? "복사됨" : "복사"}
      </Button>
      {pickerOpen ? (
        <S3PathPicker
          value={value}
          useShadcnStyles={useShadcnStyles}
          onCancel={() => setPickerOpen(false)}
          onSelect={(path) => {
            onChange(path);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function S3PathPicker({
  onCancel,
  onSelect,
  useShadcnStyles,
  value,
}: {
  onCancel: () => void;
  onSelect: (path: string) => void;
  useShadcnStyles: boolean;
  value: string;
}) {
  const parsed = useMemo(() => parseS3Path(value), [value]);
  const [buckets, setBuckets] = useState<string[]>(parsed.bucket ? [parsed.bucket] : []);
  const [bucket, setBucket] = useState(parsed.bucket);
  const [bucketError, setBucketError] = useState("");
  const [bucketsLoading, setBucketsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPrefix, setSelectedPrefix] = useState(parsed.prefix);
  const [listingCache, setListingCache] = useState<Record<string, ListingState>>({});
  const scheme = parsed.scheme || S3_SCHEME;
  const selectedPath = buildS3Path({ bucket, prefix: selectedPrefix, scheme });

  const loadBuckets = async () => {
    setBucketsLoading(true);
    setBucketError("");
    try {
      const result = await listS3Buckets();
      const nextBuckets = result.buckets.length > 0 ? result.buckets : parsed.bucket ? [parsed.bucket] : [];
      setBuckets(nextBuckets);
      setBucket((currentBucket) => currentBucket || nextBuckets[0] || "");
    } catch (error) {
      setBucketError(error instanceof Error ? error.message : "버킷 목록을 불러오지 못했습니다.");
    } finally {
      setBucketsLoading(false);
    }
  };

  const loadPrefix = async (prefix: string, continuationToken?: string | null) => {
    if (!bucket) return;
    const normalizedPrefix = normalizePrefix(prefix);
    const key = listingKey(bucket, normalizedPrefix);
    const current = listingCache[key];
    if (!continuationToken && (current?.data || current?.loading)) return;

    setListingCache((cache) => ({
      ...cache,
      [key]: { ...cache[key], error: "", loading: true },
    }));

    try {
      const result = await listS3Prefixes({ bucket, continuationToken, prefix: normalizedPrefix });
      setListingCache((cache) => {
        const previous = continuationToken ? cache[key]?.data : undefined;
        const previousFolders = previous?.folders ?? [];
        const previousFiles = previous?.files ?? [];
        return {
          ...cache,
          [key]: {
            data: {
              ...result,
              files: [...previousFiles, ...result.files],
              folders: [...previousFolders, ...result.folders],
            },
            loading: false,
          },
        };
      });
    } catch (error) {
      setListingCache((cache) => ({
        ...cache,
        [key]: {
          ...cache[key],
          error: error instanceof Error ? error.message : "주소를 불러오지 못했습니다.",
          loading: false,
        },
      }));
    }
  };

  useEffect(() => {
    void loadBuckets();
  }, []);

  useEffect(() => {
    if (!bucket) return;
    setSelectedPrefix((currentPrefix) => currentPrefix || "");
    void loadPrefix("");
  }, [bucket]);

  const treeData = useMemo<S3TreeNode[]>(() => {
    const buildChildren = (prefix: string): S3TreeNode[] => {
      const key = listingKey(bucket, prefix);
      const state = listingCache[key];
      const folders = (state?.data?.folders ?? []).filter((folder) => hasVisibleMatch(folder, query));
      const nextContinuationToken = state?.data?.nextContinuationToken ?? null;

      if (state?.loading && !state.data) {
        return [{ disabled: true, id: `state:${prefix}:loading`, kind: "loading", label: "불러오는 중...", prefix }];
      }

      if (state?.error) {
        return [{ id: `state:${prefix}:error`, kind: "error", label: "다시 시도", prefix }];
      }

      if (!state?.data || folders.length === 0) {
        return [{ disabled: true, id: `state:${prefix}:empty`, kind: "empty", label: "하위 폴더가 없습니다.", prefix }];
      }

      const children = folders.map<S3TreeNode>((folder) => ({
        children: buildChildren(folder.prefix),
        id: prefixToItemId(folder.prefix),
        kind: "folder",
        label: folder.name,
        prefix: folder.prefix,
      }));

      if (nextContinuationToken) {
        children.push({
          continuationToken: nextContinuationToken,
          id: `state:${prefix}:more:${nextContinuationToken}`,
          kind: "more",
          label: "더 불러오기",
          prefix,
        });
      }
      return children;
    };

    return [{
      children: buildChildren(""),
      id: ROOT_PREFIX_ID,
      kind: "folder",
      label: "/",
      prefix: "",
    }];
  }, [bucket, listingCache, query]);

  const getTreeIcon = (node: NodeApi<S3TreeNode>) => {
    if (node.data.kind === "loading") return <Loader2 className="animate-spin text-blue-600" />;
    if (node.data.kind === "error") return <RefreshCw className="text-red-500" />;
    if (node.data.kind === "more") return <MoreHorizontal className="text-blue-600" />;
    if (node.data.kind !== "folder") return <Folder className="text-slate-400" />;
    return node.isOpen ? <FolderOpen className="text-blue-600" /> : <Folder className="text-blue-600" />;
  };

  return (
    <PickerDialog
      contentClassName="s3-picker-dialog"
      description="버킷과 주소를 선택하면 저장경로에 반영됩니다."
      footer={(
        <>
          <div className="s3-picker-preview" title={selectedPath}>{selectedPath || "선택된 경로가 없습니다."}</div>
          <Button className={useShadcnStyles ? undefined : "secondary-button"} type="button" variant="outline" onClick={onCancel}>취소</Button>
          <Button className={useShadcnStyles ? undefined : "primary-button"} disabled={!bucket} type="button" onClick={() => onSelect(selectedPath)}>선택</Button>
        </>
      )}
      footerClassName="s3-picker-footer"
      headerClassName="s3-picker-header"
      onClose={onCancel}
      title="S3 경로 선택"
      toolbar={(
        <div className="s3-picker-toolbar">
          <Field className="field">
            <FieldLabel>Bucket</FieldLabel>
            <NativeSelect
              className="input control-input"
              disabled={bucketsLoading || buckets.length === 0}
              size="sm"
              value={bucket}
              onChange={(event) => {
                setBucket(event.target.value);
                setSelectedPrefix("");
              }}
            >
              {buckets.map((item) => <option key={item}>{item}</option>)}
            </NativeSelect>
          </Field>
          <Field className="field">
            <FieldLabel>주소 필터</FieldLabel>
            <InputGroup className="s3-picker-search">
              <InputGroupAddon>
                <Search size={14} />
              </InputGroupAddon>
              <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="주소 검색" />
            </InputGroup>
          </Field>
        </div>
      )}
      error={bucketError ? (
        <div className="s3-picker-error">
          <span>{bucketError}</span>
          <Button size="sm" type="button" variant="link" onClick={loadBuckets}>다시 시도</Button>
        </div>
      ) : null}
    >
      <div className="s3-picker-body">
        <TreePanel className="s3-tree-panel">
          <ExplorerTree<S3TreeNode>
            key={bucket}
            ariaLabel="S3 prefix tree"
            className="s3-tree h-full"
            data={treeData}
            defaultHeight={360}
            disableMultiSelection
            disableSelect={(node) => node.disabled === true || node.kind === "loading" || node.kind === "empty"}
            getIcon={getTreeIcon}
            getRowClassName={(node) => node.data.kind === "error" ? "text-red-600" : undefined}
            initialOpenState={{ [ROOT_PREFIX_ID]: true }}
            minHeight={280}
            selection={prefixToItemId(selectedPrefix)}
            onNodePress={(node) => {
              const item = node.data;
              if (item.kind === "error") {
                void loadPrefix(item.prefix);
                return;
              }
              if (item.kind === "more") {
                void loadPrefix(item.prefix, item.continuationToken);
                return;
              }
              if (item.kind === "folder") setSelectedPrefix(item.prefix);
            }}
            onToggle={(nodeId) => {
              const prefix = nodeId === ROOT_PREFIX_ID ? "" : nodeId.startsWith("prefix:") ? nodeId.slice(7) : null;
              if (prefix !== null) void loadPrefix(prefix);
            }}
          />
        </TreePanel>
      </div>
    </PickerDialog>
  );
}
