import { useCallback, useMemo } from "react";
import { Braces, Brackets, CircleDot, Rows3 } from "lucide-react";
import type { NodeApi } from "react-arborist";
import { ExplorerTree, type ExplorerTreeNode } from "@/components/ui/explorer-tree";

type SourceJsonSampleTreeProps = {
  columns: string[];
  format: string;
  rows: string[][];
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonTreeNode = ExplorerTreeNode & {
  children?: JsonTreeNode[];
  kind?: "array" | "object" | "row";
  muted?: boolean;
  value: string;
};

const MAX_RECORDS = 5;
const MAX_CHILDREN_PER_NODE = 24;
const MAX_DEPTH = 5;

const TEXT = {
  empty: "\uD45C\uC2DC\uD560 JSON \uC0D8\uD50C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.",
  fields: "\uD544\uB4DC",
  items: "\uAC1C",
  more: "\uB354\uBCF4\uAE30",
  row: "\uD589",
};

export function SourceJsonSampleTree({ columns, rows }: SourceJsonSampleTreeProps) {
  const records = useMemo(
    () => rows.slice(0, MAX_RECORDS).map((row, index) => buildRecord(columns, row, index)),
    [columns, rows],
  );
  const getIcon = useCallback((node: NodeApi<JsonTreeNode>) => {
    if (node.data.kind === "row") return <Rows3 className="text-blue-600" />;
    if (node.data.kind === "array") return <Brackets className="text-indigo-500" />;
    if (node.data.kind === "object") return <Braces className="text-blue-500" />;
    return <CircleDot className="text-slate-400" />;
  }, []);

  if (records.length === 0) {
    return <p className="source-empty-note">{TEXT.empty}</p>;
  }

  return (
    <ExplorerTree<JsonTreeNode>
      ariaLabel="JSON 샘플 트리"
      className="source-json-sample-tree"
      data={records}
      defaultHeight={280}
      disableMultiSelection
      disableSelect
      getIcon={getIcon}
      getRowClassName={(node) => node.data.muted ? "text-slate-400" : undefined}
      getRowProps={(node) => ({ title: `${node.data.label}: ${node.data.value}` })}
      minHeight={180}
      openByDefault={false}
      rowHeight={36}
    />
  );
}

function buildRecord(columns: string[], row: string[], rowIndex: number): JsonTreeNode {
  const record = columns.reduce<Record<string, JsonValue>>((acc, column, columnIndex) => {
    setPathValue(acc, column, parseCellValue(row[columnIndex]));
    return acc;
  }, {});
  return buildJsonTreeItem(record, `source-json-row-${rowIndex}`, `${rowIndex + 1}${TEXT.row}`, 0, "row");
}

function setPathValue(target: Record<string, JsonValue>, rawPath: string, value: JsonValue) {
  const segments = splitFieldPath(rawPath);
  if (segments.length === 0) return;

  let current = target;
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (isLast) {
      current[segment] = value;
      return;
    }

    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  });
}

function splitFieldPath(path: string) {
  const normalized = String(path ?? "").trim();
  if (!normalized) return [];
  return normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCellValue(value: unknown): JsonValue {
  if (value == null) return null;

  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^[\[{]/.test(normalized)) {
    try {
      return normalizeJsonValue(JSON.parse(normalized));
    } catch {
      return normalized;
    }
  }
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  return normalized;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, JsonValue>>((acc, [key, item]) => {
      acc[key] = normalizeJsonValue(item);
      return acc;
    }, {});
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        return normalizeJsonValue(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function buildJsonTreeItem(value: JsonValue, itemId: string, label: string, depth: number, rootKind?: "row"): JsonTreeNode {
  if (depth > MAX_DEPTH) {
    return {
      id: itemId,
      label,
      meta: "...",
      muted: true,
      value: "...",
    };
  }

  if (Array.isArray(value)) {
    const preview = value.slice(0, MAX_CHILDREN_PER_NODE);
    const children = preview.map((item, index) => buildJsonTreeItem(item, `${itemId}-${index}`, `[${index}]`, depth + 1));
    if (value.length > preview.length) {
      children.push({
        id: `${itemId}-more`,
        label: TEXT.more,
        meta: `+${value.length - preview.length}${TEXT.items}`,
        muted: true,
        value: `+${value.length - preview.length}${TEXT.items}`,
      });
    }
    return {
      children,
      id: itemId,
      kind: "array",
      label,
      meta: `Array[${value.length}]`,
      value: `Array[${value.length}]`,
    };
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, MAX_CHILDREN_PER_NODE);
    const children = entries.map(([key, item], index) =>
      buildJsonTreeItem(item, `${itemId}-${index}-${safeItemId(key)}`, key, depth + 1),
    );
    const totalCount = Object.keys(value).length;
    if (totalCount > entries.length) {
      children.push({
        id: `${itemId}-more`,
        label: TEXT.more,
        meta: `+${totalCount - entries.length}${TEXT.items}`,
        muted: true,
        value: `+${totalCount - entries.length}${TEXT.items}`,
      });
    }
    return {
      children,
      id: itemId,
      kind: rootKind ?? "object",
      label,
      meta: `${totalCount}${TEXT.fields}`,
      value: `${totalCount}${TEXT.fields}`,
    };
  }

  const formattedValue = formatPrimitive(value);
  return {
    id: itemId,
    label,
    meta: formattedValue,
    value: formattedValue,
  };
}

function formatPrimitive(value: JsonValue) {
  if (value === null) return "null";
  const normalized = String(value);
  if (normalized.length > 90) return `${normalized.slice(0, 87)}...`;
  return normalized;
}

function safeItemId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
