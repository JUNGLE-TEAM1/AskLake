import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";

type SourceJsonSampleTreeProps = {
  columns: string[];
  format: string;
  rows: string[][];
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type BuiltTree = {
  node: React.ReactNode;
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
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  useEffect(() => {
    setExpandedItems([]);
  }, [records]);

  if (records.length === 0) {
    return <p className="source-empty-note">{TEXT.empty}</p>;
  }

  return (
    <SimpleTreeView
      className="source-json-sample-tree"
      expandedItems={expandedItems}
      onExpandedItemsChange={(_, itemIds) => setExpandedItems(itemIds)}
    >
      {records.map((record) => record.node)}
    </SimpleTreeView>
  );
}

function buildRecord(columns: string[], row: string[], rowIndex: number): BuiltTree {
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

function buildJsonTreeItem(value: JsonValue, itemId: string, label: string, depth: number, rootKind?: "row"): BuiltTree {
  if (depth > MAX_DEPTH) {
    return {
      node: <TreeItem itemId={itemId} key={itemId} label={<JsonTreeLabel muted name={label} value="..." />} />,
    };
  }

  if (Array.isArray(value)) {
    const preview = value.slice(0, MAX_CHILDREN_PER_NODE);
    const children = preview.map((item, index) => buildJsonTreeItem(item, `${itemId}-${index}`, `[${index}]`, depth + 1));
    const overflow = value.length > preview.length
      ? <TreeItem itemId={`${itemId}-more`} key={`${itemId}-more`} label={<JsonTreeLabel muted name={TEXT.more} value={`+${value.length - preview.length}${TEXT.items}`} />} />
      : null;
    return {
      node: (
        <TreeItem itemId={itemId} key={itemId} label={<JsonTreeLabel kind="array" name={label} value={`Array[${value.length}]`} />}>
          {children.map((child) => child.node)}
          {overflow}
        </TreeItem>
      ),
    };
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, MAX_CHILDREN_PER_NODE);
    const children = entries.map(([key, item], index) =>
      buildJsonTreeItem(item, `${itemId}-${index}-${safeItemId(key)}`, key, depth + 1),
    );
    const totalCount = Object.keys(value).length;
    const overflow = totalCount > entries.length
      ? <TreeItem itemId={`${itemId}-more`} key={`${itemId}-more`} label={<JsonTreeLabel muted name={TEXT.more} value={`+${totalCount - entries.length}${TEXT.items}`} />} />
      : null;
    return {
      node: (
        <TreeItem itemId={itemId} key={itemId} label={<JsonTreeLabel kind={rootKind ?? "object"} name={label} value={`${totalCount}${TEXT.fields}`} />}>
          {children.map((child) => child.node)}
          {overflow}
        </TreeItem>
      ),
    };
  }

  return {
    node: <TreeItem itemId={itemId} key={itemId} label={<JsonTreeLabel name={label} value={formatPrimitive(value)} />} />,
  };
}

function JsonTreeLabel({
  kind,
  muted,
  name,
  value,
}: {
  kind?: "array" | "object" | "row";
  muted?: boolean;
  name: string;
  value: string;
}) {
  return (
    <span className={muted ? "source-json-node-label muted" : "source-json-node-label"} title={`${name}: ${value}`}>
      <span className="source-json-node-name">{name}</span>
      <span className={`source-json-node-value ${kind ?? ""}`}>{value}</span>
    </span>
  );
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
