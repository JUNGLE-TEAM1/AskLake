import { useEffect, useMemo, useState } from "react";
import { Check, Clipboard, Folder, FolderOpen, FolderSearch, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect } from "@/components/ui/native-select";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { TreePanel } from "@/components/ui/tree-panel";
import { TreeGroup, TreeRow, TreeView } from "@/components/ui/tree-view";
import { listS3Buckets, listS3Prefixes, type S3PrefixesResponse, type S3PrefixFolder } from "../../services/s3PathApi";
import { buildS3Path, normalizePrefix, parseS3Path, S3_SCHEME } from "../../utils/s3Path";

type S3PathFieldProps = {
  onChange: (path: string) => void;
  useShadcnStyles?: boolean;
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

export function S3PathField({ onChange, useShadcnStyles = false, value }: S3PathFieldProps) {
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
      <Button className={useShadcnStyles ? undefined : "secondary-button s3-path-action"} type="button" variant="outline" onClick={() => setPickerOpen(true)}>
        <FolderSearch data-icon="inline-start" />
        찾아보기
      </Button>
      <Button className={useShadcnStyles ? undefined : "secondary-button s3-path-action"} disabled={!value.trim()} type="button" variant="outline" onClick={copyPath}>
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
  const [buckets, setBuckets] = useState<string[]>([]);
  const [bucket, setBucket] = useState(parsed.bucket);
  const [bucketError, setBucketError] = useState("");
  const [bucketsLoading, setBucketsLoading] = useState(true);
  const [expandedItems, setExpandedItems] = useState<string[]>([ROOT_PREFIX_ID]);
  const [query, setQuery] = useState("");
  const [selectedPrefix, setSelectedPrefix] = useState(parsed.prefix);
  const [listingCache, setListingCache] = useState<Record<string, ListingState>>({});
  const scheme = parsed.scheme || S3_SCHEME;
  const bucketAllowed = !bucketsLoading && buckets.includes(bucket);
  const selectedPath = bucketAllowed ? buildS3Path({ bucket, prefix: selectedPrefix, scheme }) : "";

  const loadBuckets = async () => {
    setBucketsLoading(true);
    setBucketError("");
    try {
      const result = await listS3Buckets();
      const nextBuckets = result.buckets;
      const nextBucket = nextBuckets.includes(bucket) ? bucket : nextBuckets[0] || "";
      setBuckets(nextBuckets);
      setBucket(nextBucket);
      if (nextBucket !== bucket) setSelectedPrefix("");
    } catch (error) {
      setBuckets([]);
      setBucket("");
      setSelectedPrefix("");
      setBucketError(error instanceof Error ? error.message : "버킷 목록을 불러오지 못했습니다.");
    } finally {
      setBucketsLoading(false);
    }
  };

  const loadPrefix = async (prefix: string, continuationToken?: string | null) => {
    if (!bucket || !bucketAllowed) return;
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
    if (!bucketAllowed) return;
    setExpandedItems([ROOT_PREFIX_ID]);
    setSelectedPrefix((currentPrefix) => currentPrefix || "");
    void loadPrefix("");
  }, [bucket, bucketAllowed]);

  const togglePrefix = (prefix: string) => {
    const itemId = prefixToItemId(prefix);
    setSelectedPrefix(prefix);
    setExpandedItems((current) => {
      const isExpanded = current.includes(itemId);
      if (!isExpanded) void loadPrefix(prefix);
      return isExpanded ? current.filter((entry) => entry !== itemId) : [...current, itemId];
    });
  };

  const renderChildren = (prefix: string, depth = 1) => {
    const key = listingKey(bucket, prefix);
    const state = listingCache[key];
    const folders = (state?.data?.folders ?? []).filter((folder) => hasVisibleMatch(folder, query));
    const nextContinuationToken = state?.data?.nextContinuationToken ?? null;

    if (state?.loading && !state.data) {
      return (
        <TreeGroup className="s3-tree-group" level={depth}>
          <TreeRow className="s3-tree-row state" leaf level={depth}>
            <span className="s3-tree-state">불러오는 중...</span>
          </TreeRow>
        </TreeGroup>
      );
    }

    if (state?.error) {
      return (
        <TreeGroup className="s3-tree-group" level={depth}>
          <TreeRow className="s3-tree-row s3-tree-retry" leaf level={depth} onClick={() => loadPrefix(prefix)}>
            <span>
              <RefreshCw size={13} />
              다시 시도
            </span>
          </TreeRow>
        </TreeGroup>
      );
    }

    if (!state?.data || folders.length === 0) {
      return (
        <TreeGroup className="s3-tree-group" level={depth}>
          <TreeRow className="s3-tree-row state" leaf level={depth}>
            <span className="s3-tree-state">하위 폴더가 없습니다.</span>
          </TreeRow>
        </TreeGroup>
      );
    }

    return (
      <TreeGroup className="s3-tree-group" level={depth}>
        {folders.map((folder) => {
          const itemId = prefixToItemId(folder.prefix);
          const expanded = expandedItems.includes(itemId);
          return (
            <div className="s3-tree-item" key={folder.prefix}>
              <TreeRow
                className="s3-tree-row"
                expanded={expanded}
                level={depth}
                selected={selectedPrefix === folder.prefix}
                onClick={() => togglePrefix(folder.prefix)}
              >
                <span className={selectedPrefix === folder.prefix ? "s3-tree-label selected" : "s3-tree-label"}>
                  {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <strong>{folder.name}</strong>
                </span>
              </TreeRow>
              {expanded ? renderChildren(folder.prefix, depth + 1) : null}
            </div>
          );
        })}
        {nextContinuationToken ? (
          <TreeRow className="s3-tree-row s3-tree-more" leaf level={depth} onClick={() => loadPrefix(prefix, nextContinuationToken)}>
            <span>
              더 불러오기
            </span>
          </TreeRow>
        ) : null}
      </TreeGroup>
    );
  };

  return (
    <PickerDialog
      contentClassName="s3-picker-dialog"
      description="버킷과 주소를 선택하면 저장경로에 반영됩니다."
      footer={(
        <>
          <div className="s3-picker-preview" title={selectedPath}>{selectedPath || "선택된 경로가 없습니다."}</div>
          <Button className={useShadcnStyles ? undefined : "secondary-button"} type="button" variant="outline" onClick={onCancel}>취소</Button>
          <Button className={useShadcnStyles ? undefined : "primary-button"} disabled={bucketsLoading || !bucketAllowed || Boolean(bucketError)} type="button" onClick={() => onSelect(selectedPath)}>선택</Button>
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
          <TreeView
            className="s3-tree"
            label="S3 prefix tree"
          >
            <div className="s3-tree-item">
              <TreeRow
                className="s3-tree-row"
                expanded={expandedItems.includes(ROOT_PREFIX_ID)}
                level={0}
                selected={selectedPrefix === ""}
                onClick={() => togglePrefix("")}
              >
                <span className={selectedPrefix === "" ? "s3-tree-label selected" : "s3-tree-label"}>
                  <FolderOpen size={15} />
                  <strong>/</strong>
                </span>
              </TreeRow>
              {expandedItems.includes(ROOT_PREFIX_ID) ? renderChildren("") : null}
            </div>
          </TreeView>
        </TreePanel>
      </div>
    </PickerDialog>
  );
}
