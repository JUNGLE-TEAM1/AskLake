import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { Check, Clipboard, Folder, FolderOpen, FolderSearch, RefreshCw, Search } from "lucide-react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { Button } from "@/components/ui/button";
import { FormFieldGroup, NativeSelectField } from "@/components/ui/form-field-group";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { listS3Buckets, listS3Prefixes, type S3PrefixesResponse, type S3PrefixFolder } from "../../services/s3PathApi";
import { buildS3Path, normalizePrefix, parseS3Path, S3_SCHEME } from "../../utils/s3Path";

type S3PathFieldProps = {
  onChange: (path: string) => void;
  value: string;
};

type ListingState = {
  data?: S3PrefixesResponse;
  error?: string;
  loading?: boolean;
};

const ROOT_PREFIX_ID = "__root__";

function listingKey(bucket: string, prefix: string) {
  return `${bucket}::${normalizePrefix(prefix)}`;
}

function prefixToItemId(prefix: string) {
  return prefix ? `prefix:${prefix}` : ROOT_PREFIX_ID;
}

function itemIdToPrefix(itemId: string) {
  if (itemId === ROOT_PREFIX_ID) return "";
  return itemId.startsWith("prefix:") ? itemId.slice("prefix:".length) : "";
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

export function S3PathField({ onChange, value }: S3PathFieldProps) {
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
      <button className="secondary-button s3-path-action" type="button" onClick={() => setPickerOpen(true)}>
        <FolderSearch size={14} />
        찾아보기
      </button>
      <button className="secondary-button s3-path-action" disabled={!value.trim()} type="button" onClick={copyPath}>
        {copied ? <Check size={14} /> : <Clipboard size={14} />}
        {copied ? "복사됨" : "복사"}
      </button>
      {pickerOpen ? (
        <S3PathPicker
          value={value}
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
  value,
}: {
  onCancel: () => void;
  onSelect: (path: string) => void;
  value: string;
}) {
  const parsed = useMemo(() => parseS3Path(value), [value]);
  const [buckets, setBuckets] = useState<string[]>(parsed.bucket ? [parsed.bucket] : []);
  const [bucket, setBucket] = useState(parsed.bucket);
  const [bucketError, setBucketError] = useState("");
  const [bucketsLoading, setBucketsLoading] = useState(false);
  const [expandedItems, setExpandedItems] = useState<string[]>([ROOT_PREFIX_ID]);
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
    setExpandedItems([ROOT_PREFIX_ID]);
    setSelectedPrefix((currentPrefix) => currentPrefix || "");
    void loadPrefix("");
  }, [bucket]);

  const renderChildren = (prefix: string) => {
    const key = listingKey(bucket, prefix);
    const state = listingCache[key];
    const folders = (state?.data?.folders ?? []).filter((folder) => hasVisibleMatch(folder, query));
    const nextContinuationToken = state?.data?.nextContinuationToken ?? null;

    if (state?.loading && !state.data) {
      return <TreeItem itemId={`loading:${prefix || "root"}`} label={<span className="s3-tree-state">불러오는 중...</span>} />;
    }

    if (state?.error) {
      return (
        <TreeItem
          itemId={`error:${prefix || "root"}`}
          label={(
            <button className="s3-tree-retry" type="button" onClick={() => loadPrefix(prefix)}>
              <RefreshCw size={13} />
              다시 시도
            </button>
          )}
        />
      );
    }

    if (!state?.data || folders.length === 0) {
      return <TreeItem itemId={`empty:${prefix || "root"}`} label={<span className="s3-tree-state">하위 폴더가 없습니다.</span>} />;
    }

    return (
      <>
        {folders.map((folder) => {
          const itemId = prefixToItemId(folder.prefix);
          const expanded = expandedItems.includes(itemId);
          return (
            <TreeItem
              itemId={itemId}
              key={folder.prefix}
              label={(
                <span className={selectedPrefix === folder.prefix ? "s3-tree-label selected" : "s3-tree-label"}>
                  {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <strong>{folder.name}</strong>
                </span>
              )}
            >
              {expanded ? renderChildren(folder.prefix) : null}
            </TreeItem>
          );
        })}
        {nextContinuationToken ? (
          <TreeItem
            itemId={`more:${prefix || "root"}`}
            label={(
              <button className="s3-tree-more" type="button" onClick={() => loadPrefix(prefix, nextContinuationToken)}>
                더 불러오기
              </button>
            )}
          />
        ) : null}
      </>
    );
  };

  return (
    <PickerDialog
      contentClassName="s3-picker-dialog"
      description="버킷과 주소를 선택하면 저장경로에 반영됩니다."
      footer={(
        <>
          <div className="s3-picker-preview" title={selectedPath}>{selectedPath || "선택된 경로가 없습니다."}</div>
          <Button className="secondary-button" type="button" variant="outline" onClick={onCancel}>취소</Button>
          <Button className="primary-button" disabled={!bucket} type="button" onClick={() => onSelect(selectedPath)}>선택</Button>
        </>
      )}
      footerClassName="s3-picker-footer"
      headerClassName="s3-picker-header"
      onClose={onCancel}
      title="S3 경로 선택"
      toolbar={(
        <div className="s3-picker-toolbar">
          <NativeSelectField
            fieldClassName="field"
            label="Bucket"
            selectClassName="input control-input"
            disabled={bucketsLoading || buckets.length === 0}
            value={bucket}
            onChange={(event) => {
              setBucket(event.target.value);
              setSelectedPrefix("");
            }}
          >
            {buckets.map((item) => <option key={item}>{item}</option>)}
          </NativeSelectField>
          <FormFieldGroup className="field" label="주소 필터">
            <div className="s3-picker-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="주소 검색" />
            </div>
          </FormFieldGroup>
        </div>
      )}
      error={bucketError ? (
        <div className="s3-picker-error">
          <span>{bucketError}</span>
          <button type="button" onClick={loadBuckets}>다시 시도</button>
        </div>
      ) : null}
    >
      <div className="s3-picker-body">
          <div className="s3-tree-panel">
            <SimpleTreeView
              className="s3-tree"
              expandedItems={expandedItems}
              selectedItems={prefixToItemId(selectedPrefix)}
              onExpandedItemsChange={(_event: SyntheticEvent | null, itemIds: string[]) => {
                setExpandedItems(itemIds);
                itemIds.forEach((itemId) => {
                  if (itemId.startsWith("prefix:") || itemId === ROOT_PREFIX_ID) {
                    void loadPrefix(itemIdToPrefix(itemId));
                  }
                });
              }}
              onSelectedItemsChange={(_event: SyntheticEvent | null, itemId: string | null) => {
                if (!itemId || itemId.startsWith("loading:") || itemId.startsWith("error:") || itemId.startsWith("empty:") || itemId.startsWith("more:")) return;
                setSelectedPrefix(itemIdToPrefix(itemId));
              }}
            >
              <TreeItem
                itemId={ROOT_PREFIX_ID}
                label={(
                  <span className={selectedPrefix === "" ? "s3-tree-label selected" : "s3-tree-label"}>
                    <FolderOpen size={15} />
                    <strong>/</strong>
                  </span>
                )}
              >
                {renderChildren("")}
              </TreeItem>
            </SimpleTreeView>
          </div>
        </div>
    </PickerDialog>
  );
}
