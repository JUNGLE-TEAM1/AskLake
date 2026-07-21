import { runTransformQualitySamplePreview } from "../../data/transformQualityPreview";
import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../../types";

export type SchemaPreviewValidation = {
  issueCount: number;
  label: string;
};

export type SchemaPreviewOutputColumn = {
  column: SchemaColumnDraft;
  sourceIndex: number;
};

export type SchemaPreviewModelRow = {
  id: string;
  result: SchemaPreviewValidation;
  values: string[];
};

export function buildSchemaResultPreviewModel({
  columns,
  qualityRules,
  sampleRows,
  transformSteps,
}: {
  columns: SchemaColumnDraft[];
  qualityRules: QualityRuleDraft[];
  sampleRows: string[][];
  transformSteps: TransformStepDraft[];
}) {
  const sourceRecords = sampleRows.map((values, rowIndex) => Object.fromEntries([
    ["row_id", String(rowIndex + 1)],
    ...columns.map((column, columnIndex) => [column.sourceName, values[columnIndex] ?? ""]),
  ]));
  const enabledSteps = transformSteps.filter((step) => step.enabled).map((step) => ({
    id: step.id,
    input: step.input,
    onError: step.onError,
    operation: step.operation,
    output: step.output,
    params: String(step.canonicalParameters?.expression ?? step.canonicalParameters?.targetType ?? step.canonicalParameters?.value ?? step.params ?? ""),
  }));
  const transformedRecords = runTransformQualitySamplePreview(enabledSteps, [], sourceRecords).transformedRows;
  const outputColumns = columns
    .map((column, sourceIndex) => ({ column, sourceIndex }))
    .filter(({ column }) => column.included !== false)
    .sort((left, right) => (
      (left.column.targetOrder ?? left.sourceIndex) - (right.column.targetOrder ?? right.sourceIndex)
    ));
  const rows = transformedRecords.map((record, rowIndex) => {
    const projectedRecord = Object.fromEntries(outputColumns.map(({ column }) => {
      const outputName = column.targetName || column.sourceName;
      return [outputName, record[outputName] ?? record[column.sourceName] ?? ""];
    }));
    return {
      id: `schema-preview-${rowIndex}`,
      result: validatePreviewRecord(projectedRecord, columns, qualityRules),
      values: outputColumns.map(({ column }) => projectedRecord[column.targetName || column.sourceName] ?? ""),
    } satisfies SchemaPreviewModelRow;
  });
  return { outputColumns, rows };
}

function validatePreviewRecord(
  record: Record<string, string>,
  columns: SchemaColumnDraft[],
  qualityRules: QualityRuleDraft[],
) {
  let errorCount = 0;
  let warningCount = 0;

  qualityRules.filter((rule) => rule.enabled).forEach((rule) => {
    const column = columns.find((candidate) => (
      candidate.targetName === rule.targetColumn || candidate.sourceName === rule.targetColumn
    ));
    if (!column || column.included === false) return;
    const value = record[column.targetName || column.sourceName] ?? "";
    if (!failsRule(value, rule)) return;
    if (rule.severity === "Error") errorCount += 1;
    else warningCount += 1;
  });

  columns.forEach((column) => {
    if (column.included === false || column.nullable !== false) return;
    const hasExplicitRule = qualityRules.some((rule) => (
      rule.enabled
      && rule.validationType === "Not Null"
      && (rule.targetColumn === column.targetName || rule.targetColumn === column.sourceName)
    ));
    if (!hasExplicitRule && isBlank(record[column.targetName || column.sourceName])) errorCount += 1;
  });

  const issueCount = errorCount + warningCount;
  return {
    issueCount,
    label: issueCount === 0
      ? "통과"
      : [errorCount ? `오류 ${errorCount}` : "", warningCount ? `경고 ${warningCount}` : ""].filter(Boolean).join(" · "),
  };
}

function failsRule(value: string, rule: QualityRuleDraft) {
  if (rule.validationType === "Not Null") return isBlank(value);
  if (rule.validationType === "Range Check") {
    const [min, max] = String(rule.params || "").split(",").map((item) => Number(item.trim()));
    const numericValue = Number(value);
    return !Number.isFinite(numericValue)
      || (Number.isFinite(min) && numericValue < min)
      || (Number.isFinite(max) && numericValue > max);
  }
  if (rule.validationType === "Accepted Values") {
    const acceptedValues = String(rule.params || "").split(",").map((item) => item.trim()).filter(Boolean);
    return acceptedValues.length > 0 && !acceptedValues.includes(value);
  }
  if (rule.validationType === "Regex Match") {
    if (!rule.params) return false;
    try {
      return !new RegExp(rule.params).test(value);
    } catch {
      return false;
    }
  }
  return false;
}

function isBlank(value: string | undefined) {
  return value === undefined || value === null || value.trim() === "";
}
