import {
  Clock3,
  Database,
  Info,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import type React from "react";
import type { QualityRuleOption, TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview, TransformQualityValidationResult } from "../../data/transformQualityPreview";
import type { DraftPipeline, SchemaColumnDraft } from "../../types";
import type { QualityRuleDraft, TransformStepDraft } from "../../types/etl";

import {
  isSchemaColumnIncluded,
  normalizeTargetColumnName
} from "./schemaModel";

export type RuleCategory = "transform" | "quality";
export type RuleActionHandler = (action: string, path: string, targetId?: string) => void;
export type RuleStepDraft = {
  input: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};
export type RecipeStep = RuleStepDraft & {
  id: string;
};
export type QualityRule = QualityRuleOption;

export type TransformQualityPreviewCache = {
  datasetId: string;
  invalidRows: TransformQualityInvalidRow[];
  qualityRules: QualityRule[];
  recipeSteps: RecipeStep[];
  selectedPreviewStepId: string;
  selectedQualityRuleId: string;
  savedAt: string;
  validation: TransformQualityValidationResult;
  version: 2;
};

export const RULE_METRIC_DEFS: Array<{ icon: React.ReactNode; label: string; value: (stats: RuleStats) => string; }> = [
  { icon: <SlidersHorizontal size={18} />, label: "전체 규칙", value: (stats) => String(stats.totalRules) },
  { icon: <Database size={18} />, label: "영향 컬럼", value: (stats) => String(stats.affectedColumns) },
  { icon: <Clock3 size={18} />, label: "변환 적용률", value: (stats) => `${stats.coverage}%` },
  { icon: <Info size={18} />, label: "유효하지 않은 행", value: (stats) => String(stats.invalidRows) },
];

export const RULE_CATEGORIES: Array<{
  id: RuleCategory;
  label: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
    {
      id: "transform",
      label: "변환",
      title: "변환",
      description: "Lake 저장 전에 필드를 정리하고 타입을 맞춥니다.",
      icon: <SlidersHorizontal size={20} />,
    },
    {
      id: "quality",
      label: "품질 체크",
      title: "품질 체크",
      description: "저장 전 검증 규칙으로 데이터 품질을 확인합니다.",
      icon: <ShieldCheck size={20} />,
    },
  ];

export const FALLBACK_RECIPE_STEPS: RecipeStep[] = [{
  id: "1",
  input: "value",
  onError: "Warn",
  operation: "Lowercase + Trim",
  output: "value",
  params: "lower(), trim()",
}];
export const FALLBACK_QUALITY_RULES: QualityRule[] = [{
  failureAction: "Warn",
  id: "qr-required-value",
  severity: "Warning",
  targetColumn: "value",
  validationType: "Not Null",
}];
export const TRANSFORM_OPERATION_OPTIONS = ["Extract JSONPath", "Lowercase + Trim", "Cast Decimal", "Parse Timestamp", "Mask"] as const;
export const TRANSFORM_FAILURE_POLICY_OPTIONS = ["Warn", "Set Null", "Drop Row", "Fail Run"] as const;
export const QUALITY_VALIDATION_OPTIONS: Array<QualityRule["validationType"]> = ["Not Null", "Regex Match", "Range Check", "Accepted Values"];
export const QUALITY_SEVERITY_OPTIONS: Array<QualityRule["severity"]> = ["Warning", "Error"];
export const QUALITY_FAILURE_ACTION_OPTIONS: Array<QualityRule["failureAction"]> = ["Warn", "Quarantine", "Fail Run", "Drop Row", "Set Null"];

export const TRANSFORM_OPERATION_LABELS: Record<TransformOperation, string> = {
  "Cast Decimal": "숫자 타입 변환",
  "Extract JSONPath": "JSON 경로 추출",
  "Lowercase + Trim": "소문자/공백 정리",
  Mask: "마스킹",
  "Parse Timestamp": "시간 타입 변환",
};

export const FAILURE_ACTION_LABELS: Record<TransformFailurePolicy | QualityRule["failureAction"], string> = {
  "Drop Row": "행 제외",
  "Fail Run": "실행 실패 처리",
  Quarantine: "격리",
  "Set Null": "Null로 대체",
  Warn: "경고만 표시",
};

export const QUALITY_VALIDATION_LABELS: Record<QualityRule["validationType"], string> = {
  "Accepted Values": "허용값 검사",
  "Not Null": "필수값 검사",
  "Range Check": "범위 검사",
  "Regex Match": "정규식 검사",
};

export const QUALITY_SEVERITY_LABELS: Record<QualityRule["severity"], string> = {
  Error: "오류",
  Warning: "경고",
};

export const QUALITY_FAILURE_REASON_LABELS: Record<string, string> = {
  "Email format check failed": "이메일 형식 검사 실패",
  "Missing required value": "필수값 누락",
  "Numeric range check failed": "숫자 범위 검사 실패",
  "Value is outside accepted set": "허용값 목록 밖의 값",
};

export function transformOperationLabel(operation: string) {
  return TRANSFORM_OPERATION_LABELS[operation as TransformOperation] ?? operation;
}

export function failureActionLabel(action: string) {
  return FAILURE_ACTION_LABELS[action as TransformFailurePolicy | QualityRule["failureAction"]] ?? action;
}

export function qualityValidationLabel(validationType: string) {
  return QUALITY_VALIDATION_LABELS[validationType as QualityRule["validationType"]] ?? validationType;
}

export function qualitySeverityLabel(severity: string) {
  return QUALITY_SEVERITY_LABELS[severity as QualityRule["severity"]] ?? severity;
}

export function qualityFailureReasonLabel(reason: string) {
  return QUALITY_FAILURE_REASON_LABELS[reason] ?? reason;
}
export const QUALITY_DRAFT_PREVIEW_ID_PREFIX = "qr-draft-preview-";
export type TransformOperation = (typeof TRANSFORM_OPERATION_OPTIONS)[number];
export type TransformFailurePolicy = (typeof TRANSFORM_FAILURE_POLICY_OPTIONS)[number];

export const DEFAULT_RULE_STEP_BY_CATEGORY: Record<RuleCategory, RuleStepDraft> = {
  transform: { input: "raw_value", operation: "Extract JSONPath", output: "normalized_value", params: "$.value", onError: "Set Null" },
  quality: { input: "user_email", operation: "Regex Match", output: "quality_status", params: "email pattern", onError: "Warn" },
};

export const TRANSFORM_QUALITY_PREVIEW_CACHE_KEY = "asklake.transformQualityPreviewCache";
export const TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION = 2;

export function createDefaultTransformQualityPreviewCache(
  datasetId: string,
  recipeSteps: RecipeStep[],
  qualityRules: QualityRule[],
  validation: TransformQualityValidationResult,
): TransformQualityPreviewCache {
  return {
    datasetId,
    invalidRows: validation.failedRows,
    qualityRules,
    recipeSteps,
    selectedPreviewStepId: recipeSteps[0]?.id ?? "",
    selectedQualityRuleId: qualityRules[0]?.id ?? "",
    savedAt: new Date().toISOString(),
    validation,
    version: TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION,
  };
}

export function readTransformQualityPreviewCache(defaultCache: TransformQualityPreviewCache): TransformQualityPreviewCache {
  if (typeof window === "undefined") return defaultCache;
  try {
    const stored = window.localStorage.getItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY);
    if (!stored) return defaultCache;
    const parsed = JSON.parse(stored) as Partial<TransformQualityPreviewCache>;
    if (parsed.version !== TRANSFORM_QUALITY_PREVIEW_CACHE_VERSION || parsed.datasetId !== defaultCache.datasetId || !Array.isArray(parsed.recipeSteps) || !Array.isArray(parsed.qualityRules)) {
      return defaultCache;
    }
    const qualityRules = parsed.qualityRules.filter((rule) => !rule.id.startsWith(QUALITY_DRAFT_PREVIEW_ID_PREFIX));
    const selectedQualityRuleId = qualityRules.some((rule) => rule.id === parsed.selectedQualityRuleId)
      ? parsed.selectedQualityRuleId ?? ""
      : qualityRules[0]?.id ?? defaultCache.selectedQualityRuleId;
    return {
      ...defaultCache,
      ...parsed,
      invalidRows: Array.isArray(parsed.invalidRows) ? parsed.invalidRows : defaultCache.invalidRows,
      qualityRules: qualityRules.length > 0 ? qualityRules : defaultCache.qualityRules,
      recipeSteps: parsed.recipeSteps.length > 0 ? parsed.recipeSteps : defaultCache.recipeSteps,
      selectedQualityRuleId,
      validation: parsed.validation ?? defaultCache.validation,
    };
  } catch {
    return defaultCache;
  }
}

export function writeTransformQualityPreviewCache(cache: TransformQualityPreviewCache) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRANSFORM_QUALITY_PREVIEW_CACHE_KEY, JSON.stringify(cache));
}

export function schemaColumnOutputName(column: SchemaColumnDraft) {
  return (column.targetName || column.sourceName || "column").trim();
}

export function getRuleSourceColumns(columns: SchemaColumnDraft[]) {
  return columns.filter(isSchemaColumnIncluded).map(schemaColumnOutputName).filter(Boolean);
}

export function getRuleDatasetId(draft: DraftPipeline) {
  return [
    draft.source.sourceType,
    draft.source.sourceLabel,
    draft.schema.schemaFingerprint,
    draft.schema.columns.map((column) => schemaColumnOutputName(column)).join(","),
  ].filter(Boolean).join("|");
}

export function schemaRowsToRuleSampleRows(columns: SchemaColumnDraft[], rows: string[][]): TransformQualitySampleRow[] {
  const outputNames = getRuleSourceColumns(columns);
  return rows.map((row, rowIndex) => {
    const nextRow: TransformQualitySampleRow = { row_id: String(rowIndex + 1) };
    columns.forEach((column, columnIndex) => {
      if (!isSchemaColumnIncluded(column)) return;
      const value = row[columnIndex] ?? "";
      const outputName = schemaColumnOutputName(column);
      if (outputName) nextRow[outputName] = value;
      if (column.sourceName && column.sourceName !== outputName) nextRow[column.sourceName] = value;
    });
    if (!nextRow.row_id && outputNames[0]) nextRow.row_id = nextRow[outputNames[0]] ?? String(rowIndex + 1);
    return nextRow;
  });
}

export function isJsonLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return probe.includes("json") || probe.includes("payload") || probe.includes("metadata") || probe.includes("profile");
}

export function isTimestampLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return probe.includes("timestamp") || probe.includes("datetime") || probe.includes("_at") || probe.endsWith(" date") || probe.includes("date");
}

export function isNumericLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName} ${column.type}`.toLowerCase();
  return ["int", "long", "float", "double", "decimal", "number", "numeric"].some((token) => probe.includes(token));
}

export function isEmailLikeColumn(column: SchemaColumnDraft) {
  return `${column.sourceName} ${column.targetName}`.toLowerCase().includes("email");
}

export function isCountryLikeColumn(column: SchemaColumnDraft) {
  const probe = `${column.sourceName} ${column.targetName}`.toLowerCase();
  return probe.includes("country") || probe.includes("region");
}

export function buildDefaultRecipeSteps(draft: DraftPipeline): RecipeStep[] {
  const columns = draft.schema.columns.filter(isSchemaColumnIncluded);
  if (columns.length === 0) return FALLBACK_RECIPE_STEPS.slice(0, 1);
  const candidates: RecipeStep[] = [];
  const addStep = (column: SchemaColumnDraft, operation: TransformOperation, output?: string, params?: string, onError: TransformFailurePolicy = "Warn") => {
    const input = schemaColumnOutputName(column);
    if (!input || candidates.some((step) => step.input === input && step.operation === operation)) return;
    candidates.push({
      id: String(candidates.length + 1),
      input,
      onError,
      operation,
      output: output ?? getRecommendedOutputColumn(operation, input),
      params: params ?? getDefaultParamForOperation(operation),
    });
  };

  const jsonColumn = columns.find(isJsonLikeColumn);
  if (jsonColumn) addStep(jsonColumn, "Extract JSONPath", `${schemaColumnOutputName(jsonColumn)}_value`, "$.value", "Set Null");
  const emailColumn = columns.find(isEmailLikeColumn);
  if (emailColumn) addStep(emailColumn, "Lowercase + Trim");
  const numericColumn = columns.find(isNumericLikeColumn);
  if (numericColumn) addStep(numericColumn, "Cast Decimal", schemaColumnOutputName(numericColumn), "double");
  const timestampColumn = columns.find(isTimestampLikeColumn);
  if (timestampColumn) addStep(timestampColumn, "Parse Timestamp", `${schemaColumnOutputName(timestampColumn)}_ts`, "UTC", "Set Null");
  const stringColumn = columns.find((column) => !isNumericLikeColumn(column) && !isTimestampLikeColumn(column) && !isJsonLikeColumn(column));
  if (candidates.length === 0 && stringColumn) addStep(stringColumn, "Lowercase + Trim");

  return candidates.length > 0 ? candidates.slice(0, 5) : FALLBACK_RECIPE_STEPS.slice(0, 1);
}

export function buildDefaultQualityRules(draft: DraftPipeline): QualityRule[] {
  const columns = draft.schema.columns.filter(isSchemaColumnIncluded);
  if (columns.length === 0) return FALLBACK_QUALITY_RULES.slice(0, 1);
  const rules: QualityRule[] = [];
  const addRule = (
    column: SchemaColumnDraft | undefined,
    validationType: QualityRule["validationType"],
    severity: QualityRule["severity"] = "Warning",
    failureAction: QualityRule["failureAction"] = "Warn",
  ) => {
    if (!column) return;
    const targetColumn = schemaColumnOutputName(column);
    if (!targetColumn || rules.some((rule) => rule.targetColumn === targetColumn && rule.validationType === validationType)) return;
    rules.push({
      failureAction,
      id: `qr-${rules.length + 1}-${normalizeTargetColumnName(targetColumn)}`,
      severity,
      targetColumn,
      validationType,
    });
  };

  addRule(columns.find((column) => !column.nullable) ?? columns[0], "Not Null", "Error", "Fail Run");
  addRule(columns.find(isEmailLikeColumn), "Regex Match", "Warning", "Quarantine");
  addRule(columns.find(isNumericLikeColumn), "Range Check", "Warning", "Quarantine");
  addRule(columns.find(isCountryLikeColumn), "Accepted Values", "Warning", "Warn");
  return rules.length > 0 ? rules.slice(0, 5) : FALLBACK_QUALITY_RULES.slice(0, 1);
}

export function typeForOutputColumn(name: string, steps: RecipeStep[], schemaColumns: SchemaColumnDraft[], previewRows: TransformQualitySampleRow[]) {
  const sourceColumn = schemaColumns.find((column) => isSchemaColumnIncluded(column) && (schemaColumnOutputName(column) === name || column.sourceName === name));
  const producingStep = steps.find((step) => step.output === name);
  if (producingStep) {
    const operation = producingStep.operation.toLowerCase();
    if (operation.includes("timestamp") || operation.includes("date")) return "timestamp";
    if (operation.includes("decimal") || operation.includes("cast")) return "double";
    if (operation.includes("json")) return "string";
  }
  if (sourceColumn) return sourceColumn.type;
  const sampleValue = previewRows.map((row) => row[name]).find((value) => value !== undefined && value !== "");
  if (sampleValue && Number.isFinite(Number(sampleValue))) return "double";
  return "string";
}

export function buildTransformOutputColumns(
  steps: RecipeStep[],
  schemaColumns: SchemaColumnDraft[],
  previewRows: TransformQualitySampleRow[],
) {
  const baseColumns = getRuleSourceColumns(schemaColumns);
  const previewColumns = previewRows[0] ? Object.keys(previewRows[0]).filter((column) => column !== "row_id") : [];
  const columns = Array.from(new Set([...baseColumns, ...steps.map((step) => step.output.trim()).filter(Boolean), ...previewColumns]));
  return columns.map((column) => [column, typeForOutputColumn(column, steps, schemaColumns, previewRows)] as [string, string]);
}

export type RuleStats = {
  affectedColumns: number;
  coverage: number;
  invalidRows: number;
  qualityRules: number;
  transformSteps: number;
  totalRules: number;
};

export function getRuleStats(steps: RecipeStep[], qualityRules: QualityRule[], invalidRows: number, baseColumnCount: number): RuleStats {
  const affectedColumns = new Set(steps.flatMap((step) => [step.input, step.output].filter(Boolean)));
  return {
    affectedColumns: Math.max(affectedColumns.size, baseColumnCount),
    coverage: baseColumnCount > 0 ? Math.min(100, Math.round((affectedColumns.size / Math.max(baseColumnCount, 1)) * 100)) : 0,
    invalidRows,
    qualityRules: qualityRules.length,
    transformSteps: steps.length,
    totalRules: steps.length + qualityRules.length,
  };
}

export function formatTransformSummary(stats: RuleStats) {
  return `변환 단계 ${stats.transformSteps}개 · 영향 컬럼 ${stats.affectedColumns}개 · 적용률 ${stats.coverage}%`;
}

export function getTransformStepKind(operation: string): TransformStepDraft["kind"] {
  const normalizedOperation = operation.toLowerCase();
  if (normalizedOperation.includes("json")) return "jsonPath";
  if (normalizedOperation.includes("cast") || normalizedOperation.includes("decimal")) return "cast";
  if (normalizedOperation.includes("trim") || normalizedOperation.includes("lower")) return "trim";
  if (normalizedOperation.includes("mask")) return "mask";
  return "derive";
}

export function toDraftTransformSteps(steps: RecipeStep[]): TransformStepDraft[] {
  return steps.map((step) => ({
    enabled: true,
    id: step.id,
    input: step.input,
    kind: getTransformStepKind(step.operation),
    label: `${transformOperationLabel(step.operation)}: ${step.input} -> ${step.output}`,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: step.params,
  }));
}

export function toQualityRuleKind(validationType: QualityRule["validationType"]): QualityRuleDraft["kind"] {
  switch (validationType) {
    case "Accepted Values":
      return "acceptedValues";
    case "Not Null":
      return "notNull";
    case "Range Check":
      return "range";
    case "Regex Match":
      return "regex";
    default:
      return "regex";
  }
}

export function toDraftQualityRules(rules: QualityRule[]): QualityRuleDraft[] {
  return rules.map((rule) => ({
    enabled: true,
    failureAction: rule.failureAction,
    id: rule.id,
    kind: toQualityRuleKind(rule.validationType),
    severity: rule.severity,
    targetColumn: rule.targetColumn,
    validationType: rule.validationType,
  }));
}

export function toDraftInvalidRows(rows: TransformQualityInvalidRow[]) {
  return rows.map((row) => [row.row, row.column, row.reason, row.action]);
}

export function formatInvalidRowsPreviewSummary(invalidRowCount: number, exampleCount: number) {
  if (invalidRowCount === exampleCount) return `유효하지 않은 행 ${invalidRowCount}개`;
  return `유효하지 않은 행 ${invalidRowCount}개 · 예시 ${exampleCount}개 표시`;
}

export function getWorkingColumns(steps: RecipeStep[], sourceColumns: string[]) {
  return Array.from(new Set([
    ...sourceColumns,
    ...steps.map((step) => step.output.trim()).filter(Boolean),
  ]));
}

export function getDerivedColumns(steps: RecipeStep[], sourceColumnSet: Set<string>) {
  return Array.from(new Set(
    steps
      .map((step) => step.output.trim())
      .filter((column) => column && !sourceColumnSet.has(column)),
  ));
}

export function getPermanentQualityRules(rules: QualityRule[]) {
  return rules.filter((rule) => !rule.id.startsWith(QUALITY_DRAFT_PREVIEW_ID_PREFIX));
}

export function replaceOrAppendById<T extends { id: string; }>(items: T[], nextItem: T) {
  return items.some((item) => item.id === nextItem.id)
    ? items.map((item) => item.id === nextItem.id ? nextItem : item)
    : [...items, nextItem];
}

export function getTransformFailurePolicy(value: string): TransformFailurePolicy {
  return TRANSFORM_FAILURE_POLICY_OPTIONS.find((option) => option === value) ?? "Warn";
}

export function createRecipeStepFromDraft(draft: RuleStepDraft, id: string, fallback: RuleStepDraft = DEFAULT_RULE_STEP_BY_CATEGORY.transform): RecipeStep {
  return {
    id,
    input: draft.input.trim() || fallback.input,
    onError: draft.onError.trim() || fallback.onError,
    operation: draft.operation.trim() || fallback.operation,
    output: draft.output.trim() || fallback.output,
    params: draft.params.trim() || fallback.params,
  };
}

export function recipeStepToRuleStepDraft(step: RecipeStep): RuleStepDraft {
  return {
    input: step.input,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: step.params,
  };
}

export function qualityRuleToRuleStepDraft(rule: QualityRule): RuleStepDraft {
  return {
    input: rule.targetColumn,
    onError: rule.failureAction,
    operation: rule.validationType,
    output: "validation_status",
    params: rule.severity,
  };
}

export function getQualityRuleInvalidRows(rows: TransformQualityInvalidRow[], rule: QualityRule) {
  const rowsWithRuleIds = rows.filter((row) => row.ruleId);
  if (rowsWithRuleIds.length > 0) return rows.filter((row) => row.ruleId === rule.id);
  return rows.filter((row) => row.column === rule.targetColumn);
}

export function getQualityValidationType(operation: string): QualityRule["validationType"] {
  const validationType = operation.trim() as QualityRule["validationType"];
  return QUALITY_VALIDATION_OPTIONS.find((option) => option === validationType) ?? "Regex Match";
}

export function getQualitySeverity(severity: string): QualityRule["severity"] {
  const nextSeverity = severity.trim() as QualityRule["severity"];
  return QUALITY_SEVERITY_OPTIONS.find((option) => option === nextSeverity) ?? "Warning";
}

export function getQualityFailureAction(failureAction: string): QualityRule["failureAction"] {
  const nextFailureAction = failureAction.trim() as QualityRule["failureAction"];
  return QUALITY_FAILURE_ACTION_OPTIONS.find((option) => option === nextFailureAction) ?? "Warn";
}

export function createQualityRuleFromDraft(draft: RuleStepDraft, id: string): QualityRule {
  const fallback = DEFAULT_RULE_STEP_BY_CATEGORY.quality;
  return {
    failureAction: getQualityFailureAction(draft.onError || fallback.onError),
    id,
    severity: getQualitySeverity(draft.params || "Warning"),
    targetColumn: draft.input.trim() || fallback.input,
    validationType: getQualityValidationType(draft.operation || fallback.operation),
  };
}

export function getAllowedTransformOperation(operation: string | undefined): TransformOperation {
  return TRANSFORM_OPERATION_OPTIONS.find((option) => option === operation) ?? "Extract JSONPath";
}

export function getDefaultParamForOperation(operation: TransformOperation) {
  switch (operation) {
    case "Extract JSONPath":
      return "$.user.contact.email";
    case "Lowercase + Trim":
      return "lower(), trim()";
    case "Cast Decimal":
      return "decimal(10,2)";
    case "Parse Timestamp":
      return "UTC";
    case "Mask":
      return "keep first 3 digits";
    default:
      return "";
  }
}

export function getRecommendedOutputColumn(operation: TransformOperation, inputColumn: string) {
  if (operation === "Extract JSONPath" && inputColumn === "meta_json") return "user_email";
  if (operation === "Parse Timestamp" && inputColumn === "created_at") return "created_at_utc";
  if (operation === "Mask" && inputColumn === "phone_number") return "phone_masked";
  return inputColumn || "normalized_value";
}

export function buildStepImpactRows(
  beforeRows: string[][],
  afterRows: string[][],
  columns: string[],
  step: RecipeStep,
  preview?: TransformQualityPreviewSample | TransformQualityStepPreview,
) {
  const rowIdIndex = Math.max(0, columns.indexOf("row_id"));
  const inputIndex = columns.indexOf(step.input);
  const outputIndex = columns.reduce((matchedIndex, column, index) => column === step.output ? index : matchedIndex, -1);
  const safeInputIndex = inputIndex >= 0 ? inputIndex : 0;
  const safeOutputIndex = outputIndex >= 0 ? outputIndex : columns.length - 1;
  const sourceRows = beforeRows.length > 0
    ? beforeRows.slice(0, 5)
    : Array.from({ length: 3 }, (_, index) => [String(index + 1), preview?.inputValue ?? "", preview?.outputValue ?? ""]);

  return sourceRows.map((row, index) => {
    const afterRow = afterRows[index] ?? row;
    const beforeOutputValue = row[safeOutputIndex] ?? "";
    const afterValue = afterRow[safeOutputIndex] ?? preview?.outputValue ?? "";
    const changed = afterValue !== beforeOutputValue;
    const statusClass = step.input !== step.output ? "derived" : changed ? "changed" : "unchanged";
    const statusLabel = step.input !== step.output ? "파생" : changed ? "변경됨" : "변경 없음";

    return {
      afterValue: truncatePreviewValue(afterValue),
      beforeValue: truncatePreviewValue(row[safeInputIndex] ?? ""),
      rowId: row[rowIdIndex] ?? String(index + 1),
      statusClass,
      statusLabel,
    };
  });
}

export function truncatePreviewValue(value: string) {
  if (value.length <= 120) return value;
  return `${value.slice(0, 117)}...`;
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const escapeCell = (value: string | number) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
