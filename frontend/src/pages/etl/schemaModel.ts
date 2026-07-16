import type { DraftPipeline, SchemaColumnDraft } from "../../types";


export const schemaTypeOptions = ["String", "Integer", "Long", "Double", "Boolean", "Timestamp", "Date", "JSON"];
export const schemaRoleOptions = [
  { label: "일반", value: "" },
  { label: "식별자", value: "Identifier" },
  { label: "이벤트 시간", value: "Event Time" },
  { label: "측정값", value: "Metric" },
  { label: "개인정보", value: "PII" },
];

export type SchemaBaseSnapshot = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  sourceLabel: string;
};

export type SchemaSampleScope = "current" | "slice1gb" | "full";
export type SchemaSampleScopeOption = {
  label: string;
  shortLabel: string;
  value: SchemaSampleScope;
};

export function schemaSampleScopeOptionsForSource(sourceType: string): SchemaSampleScopeOption[] {
  if (sourceType === "SQL Result") {
    return [
      { label: "SQL Preview", shortLabel: "Preview", value: "current" },
    ];
  }
  if (sourceType === "MongoDB") {
    return [
      { label: "현재 문서", shortLabel: "현재", value: "current" },
      { label: "10k 문서", shortLabel: "10k", value: "slice1gb" },
      { label: "전체 컬렉션", shortLabel: "전체", value: "full" },
    ];
  }
  if (sourceType === "PostgreSQL") {
    return [
      { label: "현재 행", shortLabel: "현재", value: "current" },
      { label: "10k 행", shortLabel: "10k", value: "slice1gb" },
      { label: "전체 테이블", shortLabel: "전체", value: "full" },
    ];
  }
  return [
    { label: "현재 샘플", shortLabel: "현재", value: "current" },
    { label: "1GB 요청(기본 16MB 제한)", shortLabel: "1GB", value: "slice1gb" },
    { label: "전체", shortLabel: "전체", value: "full" },
  ];
}

export function detectSchemaSourceFormat(draft: DraftPipeline) {
  const summary = draft.schema.summary.toLowerCase();
  const sampleObject = draft.source.sourceConfig.find(([label]) => label === "__Sample Object")?.[1]?.toLowerCase() ?? "";
  const sourceLabel = draft.source.sourceLabel.toLowerCase();
  const probe = `${summary} ${sampleObject} ${sourceLabel}`;
  if (probe.includes("jsonl")) return "JSONL";
  if (probe.includes("json")) return "JSON";
  if (probe.includes("parquet")) return "PARQUET";
  if (probe.includes(".txt") || probe.includes(".log") || probe.includes(" txt") || probe.includes(" log")) return "TXT";
  if (probe.includes("tsv")) return "TSV";
  if (probe.includes("csv")) return "CSV";
  if (draft.source.sourceType === "PostgreSQL") return "TABLE";
  if (draft.source.sourceType === "MongoDB") return "JSON";
  if (draft.source.sourceType === "Stream / Kafka") return "JSON";
  if (draft.source.sourceType === "SQL Result") return "SQL";
  return "SAMPLE";
}

export function buildSchemaFingerprint(columns: SchemaColumnDraft[]) {
  return columns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}:${isSchemaColumnIncluded(column) ? "included" : "excluded"}`).join("|");
}

export function summarizeSchemaColumns(columns: SchemaColumnDraft[], lowConfidenceCount: number, sourceFormat: string) {
  const includedCount = columns.filter(isSchemaColumnIncluded).length;
  const excludedCount = Math.max(0, columns.length - includedCount);
  const excludedSummary = excludedCount > 0 ? ` · ${excludedCount}개 출력 제외` : "";
  return `${includedCount}개 출력 컬럼 구성${excludedSummary} · ${lowConfidenceCount}개 검토 필요 · ${sourceFormat} 샘플 기준`;
}

export function isSchemaColumnIncluded(column: SchemaColumnDraft) {
  return column.included !== false;
}

export function normalizeTargetColumnName(value: string) {
  return value
    .trim()
    .replace(/[^0-9A-Za-z_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

export function withUniqueTargetNames(columns: SchemaColumnDraft[]) {
  const counts = new Map<string, number>();
  return columns.map((column) => {
    const baseName = normalizeTargetColumnName(column.sourceName);
    const seen = counts.get(baseName) ?? 0;
    counts.set(baseName, seen + 1);
    return {
      ...column,
      targetName: seen === 0 ? baseName : `${baseName}_${seen + 1}`,
    };
  });
}

export function cloneSchemaColumns(columns: SchemaColumnDraft[]) {
  return columns.map((column) => ({ ...column }));
}

export function cloneSchemaRows(rows: string[][]) {
  return rows.map((row) => [...row]);
}

export function upsertConfigValue(config: Array<[string, string]>, label: string, value: string) {
  const found = config.some(([fieldLabel]) => fieldLabel === label);
  if (found) {
    return config.map(([fieldLabel, fieldValue]) => (fieldLabel === label ? [fieldLabel, value] : [fieldLabel, fieldValue])) as Array<[string, string]>;
  }
  return [...config, [label, value]] as Array<[string, string]>;
}

export function compactSchemaByPathDepth(columns: SchemaColumnDraft[], sampleRows: string[][], maxPathSegments: number) {
  const safeDepth = Math.max(1, Math.trunc(maxPathSegments));
  const groups = new Map<string, {
    columns: Array<{ column: SchemaColumnDraft; index: number; relativePath: string; }>;
    firstIndex: number;
    key: string;
  }>();

  columns.forEach((column, index) => {
    const parts = column.sourceName.split(".").filter(Boolean);
    const compactParts = parts.length > safeDepth ? parts.slice(0, safeDepth) : parts;
    const key = compactParts.join(".") || column.sourceName || `column_${index + 1}`;
    const relativePath = parts.slice(compactParts.length).join(".");
    const group = groups.get(key);
    if (group) {
      group.columns.push({ column, index, relativePath });
      return;
    }
    groups.set(key, { columns: [{ column, index, relativePath }], firstIndex: index, key });
  });

  const orderedGroups = Array.from(groups.values()).sort((a, b) => a.firstIndex - b.firstIndex);
  const nextColumns = orderedGroups.map((group) => {
    if (group.columns.length === 1 && !group.columns[0].relativePath) {
      return { ...group.columns[0].column };
    }
    const confidenceValues = group.columns.map(({ column }) => column.confidence ?? 70);
    return {
      confidence: Math.min(...confidenceValues),
      included: group.columns.some(({ column }) => isSchemaColumnIncluded(column)),
      nullable: group.columns.some(({ column }) => column.nullable),
      sourceName: group.key,
      targetName: normalizeTargetColumnName(group.key),
      type: "JSON",
    } satisfies SchemaColumnDraft;
  });

  const nextRows = sampleRows.map((row) => orderedGroups.map((group) => {
    if (group.columns.length === 1 && !group.columns[0].relativePath) {
      return row[group.columns[0].index] ?? "";
    }
    const nested: Record<string, unknown> = {};
    group.columns.forEach(({ column, index, relativePath }) => {
      const value = row[index] ?? "";
      if (!value.trim()) return;
      setNestedPreviewValue(nested, relativePath || column.sourceName.split(".").at(-1) || "value", value);
    });
    return Object.keys(nested).length > 0 ? JSON.stringify(nested) : "";
  }));

  return { columns: nextColumns, sampleRows: nextRows };
}

export function buildSourceShapePreview(columns: SchemaColumnDraft[], row: string[]) {
  if (columns.length === 0) return "연결 테스트 후 샘플 구조가 표시됩니다.";
  const preview: Record<string, unknown> = {};
  const visibleColumns = columns.slice(0, 10);
  visibleColumns.forEach((column, index) => {
    setNestedPreviewValue(preview, column.sourceName, row[index] ?? "");
  });
  if (columns.length > visibleColumns.length) {
    preview.__remaining_fields = `${columns.length - visibleColumns.length}개 추가 필드`;
  }
  return JSON.stringify(preview, null, 2);
}

export function buildCsvShapePreview(columns: SchemaColumnDraft[], row: string[]) {
  if (columns.length === 0) return "출력 컬럼이 없습니다.";
  const visibleColumns = columns.slice(0, 10);
  const header = visibleColumns.map((column, index) => toCsvPreviewCell(column.targetName || `column_${index + 1}`)).join(",");
  const values = visibleColumns.map((_, index) => toCsvPreviewCell(row[index] ?? "")).join(",");
  const suffix = columns.length > visibleColumns.length ? `\n... ${columns.length - visibleColumns.length}개 컬럼 더 있음` : "";
  return `${header}\n${values}${suffix}`;
}

export function setNestedPreviewValue(target: Record<string, unknown>, sourceName: string, value: string) {
  const parts = sourceName.split(".").filter(Boolean);
  if (parts.length <= 1) {
    target[sourceName || "value"] = value;
    return;
  }
  let cursor = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  });
}

export function toCsvPreviewCell(value: string) {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function sampleValuesForColumn(rows: string[][], columnIndex: number) {
  return rows.map((row) => row[columnIndex] ?? "").filter((value) => value.trim() !== "");
}

export function estimateNullRatio(rows: string[][], columnIndex: number) {
  if (rows.length === 0) return 0;
  const nullCount = rows.filter((row) => !(row[columnIndex] ?? "").trim()).length;
  return Math.round((nullCount / rows.length) * 100);
}

export function valueDistribution(values: string[]) {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const key = value.length > 24 ? `${value.slice(0, 24)}...` : value;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const max = Math.max(...counts.values(), 0);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => ({ count, label, percent: max > 0 ? Math.max(8, Math.round((count / max) * 100)) : 0 }));
}

export function compactSchemaPreviewValue(value: string, maxLength = 44) {
  const normalized = value.trim() || "null";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(8, maxLength - 14))}...${normalized.slice(-8)}`;
}

export function schemaTransformLabel(column: SchemaColumnDraft) {
  const actions: string[] = [];
  if (!isSchemaColumnIncluded(column)) actions.push("출력에서 제외");
  if (column.sourceName.includes(".")) actions.push("중첩 경로 평탄화");
  if ((column.targetName || "") !== normalizeTargetColumnName(column.sourceName)) actions.push("출력 필드명 변경");
  if (column.type) actions.push(`${column.type} 타입 변환`);
  actions.push(column.nullable ? "Null 허용" : "필수");
  return actions.join(" · ");
}

export function schemaTransformShortLabel(column: SchemaColumnDraft) {
  const actions: string[] = [];
  if (!isSchemaColumnIncluded(column)) actions.push("제외");
  if (column.sourceName.includes(".")) actions.push("평탄화");
  if ((column.targetName || "") !== normalizeTargetColumnName(column.sourceName)) actions.push("이름 변경");
  if (column.type) actions.push("타입 변환");
  return actions.length > 0 ? actions.join(" + ") : "그대로";
}
export function schemaFlowWindow(columns: SchemaColumnDraft[], sampleRows: string[][], selectedIndex: number) {
  const maxItems = 6;
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(columns.length - 1, 0)));
  const start = Math.max(0, Math.min(safeSelectedIndex - 3, Math.max(columns.length - maxItems, 0)));
  return columns.slice(start, start + maxItems).map((column, offset) => {
    const index = start + offset;
    return {
      action: schemaTransformLabel(column),
      actionShort: schemaTransformShortLabel(column),
      included: isSchemaColumnIncluded(column),
      index,
      nullable: column.nullable ? "Null 허용" : "필수",
      sample: compactSchemaPreviewValue(sampleRows[0]?.[index] ?? ""),
      sourceName: column.sourceName,
      targetName: column.targetName || `column_${index + 1}`,
      type: column.type,
    };
  });
}

export function schemaRoleLabel(role?: string) {
  return schemaRoleOptions.find((option) => option.value === (role ?? ""))?.label ?? role ?? "일반";
}

export function formatSourceFieldPath(value: string) {
  if (!value.includes(".")) return value;
  const parts = value.split(".");
  return parts.map((part, index) => (index === 0 ? part : `└ ${part}`)).join(" ");
}
