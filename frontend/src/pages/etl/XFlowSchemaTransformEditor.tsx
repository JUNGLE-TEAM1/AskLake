import { useMemo } from "react";
import SchemaTransformEditor from "../../components/etl/SchemaTransformEditor.jsx";
import {
  runTransformQualitySamplePreview,
  type TransformQualitySampleRow,
} from "../../data/transformQualityPreview";
import "../../styles/xflow-source.css";
import "../../styles/xflow-adapter.css";
import type { SchemaColumnDraft, TransformChainStepDraft, TransformStepDraft } from "../../types";

type XFlowColumn = {
  defaultValue?: string;
  expandedFrom?: string;
  expandedIndex?: number;
  expandedTotal?: number;
  name: string;
  notNull?: boolean;
  onError?: string;
  originalName?: string;
  originalType?: string;
  reviewAnalysisInstruction?: string;
  reviewAnalysisMethod?: string;
  sourceId?: string | null;
  sourceName?: string;
  transform?: string | null;
  transformChain?: TransformChainStepDraft[];
  transformDisplay?: string | null;
  transformOperation?: string | null;
  transformParams?: string | null;
  type: string;
};

type XFlowSchemaTransformEditorProps = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  selectedIndex: number;
  sourceFormat: string;
  transformSteps?: TransformStepDraft[];
  onColumnsChange: (columns: SchemaColumnDraft[], sampleRows?: string[][]) => void;
  onSelectedIndexChange: (index: number) => void;
  onTransformStepsChange?: (steps: TransformStepDraft[]) => void;
};

type CsvClassifierRule = {
  condition: string;
  pattern: string;
  value: string;
};

type CsvClassifierConfig = {
  fallbackValue: string;
  rules: CsvClassifierRule[];
  sourceField: string;
};

const XFLOW_SOURCE_ID = "asklake-source";
const XFLOW_DATASET_ID = "asklake-draft-source";
const XFLOW_COLUMN_STEP_PREFIX = "xflow-col-";
const XFLOW_SQL_STEP_ID = "xflow-sql-transform";
const CUSTOM_CSV_CLASSIFIER = "Custom CSV Classifier";
const REVIEW_ROW_ANALYSIS = "Review Row Analysis";
const TEXT_ROW_ANALYSIS = "Text Row Analysis";
const FIELD_ONLY_OPERATIONS = new Set(["Default Value", "Null Guard"]);

export function XFlowSchemaTransformEditor({
  columns,
  sampleRows,
  selectedIndex,
  sourceFormat,
  transformSteps = [],
  onColumnsChange,
  onSelectedIndexChange,
  onTransformStepsChange,
}: XFlowSchemaTransformEditorProps) {
  const sourceSchema = useMemo(() => columns
    .filter((column) => !isInternalDerivedColumn(column))
    .map((column) => ({
      field: column.sourceName,
      name: column.sourceName,
      type: toXFlowType(column.type),
    })), [columns]);

  const targetSchema = useMemo(
    () => columns
      .filter((column) => column.included !== false)
      .map((column) => toXFlowTargetColumn(column, transformSteps)),
    [columns, transformSteps],
  );

  const allSources = useMemo(() => [{
    datasetId: XFLOW_DATASET_ID,
    id: XFLOW_SOURCE_ID,
    name: sourceFormat || "Source",
    schema: sourceSchema,
    sourceType: sourceFormat?.toLowerCase?.() ?? "source",
  }], [sourceFormat, sourceSchema]);

  const handleSchemaChange = (nextTargetSchema: XFlowColumn[]) => {
    const columnSteps = buildTransformSteps(nextTargetSchema);
    const { nextColumns, nextRows } = projectXFlowSchema(columns, sampleRows, nextTargetSchema, columnSteps);
    onColumnsChange(nextColumns, nextRows);
    onSelectedIndexChange(Math.min(selectedIndex, Math.max(nextColumns.length - 1, 0)));
    onTransformStepsChange?.(mergeXFlowColumnSteps(transformSteps, columnSteps));
  };

  const handleSqlChange = (sql: string, mode?: "columns" | "sql") => {
    if (mode !== "sql") return;
    onTransformStepsChange?.(upsertSqlTransformStep(transformSteps, sql, sourceFormat));
  };

  return (
    <div className="asklake-xflow-source-adapter">
      <div className="asklake-xflow-scroll-frame">
        <SchemaTransformEditor
          allSources={allSources}
          initialCustomSql={getInitialCustomSql(transformSteps)}
          initialTargetSchema={targetSchema}
          onSchemaChange={handleSchemaChange}
          onSqlChange={handleSqlChange}
          onTestStatusChange={() => undefined}
          sourceDatasetId={XFLOW_DATASET_ID}
          sourceId={XFLOW_SOURCE_ID}
          sourceName={sourceFormat || "Source"}
          sourceSchema={sourceSchema}
          sourceTabs={null}
          targetSchema={targetSchema}
        />
      </div>
    </div>
  );
}

function toXFlowTargetColumn(column: SchemaColumnDraft, transformSteps: TransformStepDraft[]): XFlowColumn {
  const outputName = column.targetName || column.sourceName;
  const stepsForOutput = transformSteps
    .filter((item) => item.output === outputName && item.id !== XFLOW_SQL_STEP_ID)
    .filter((item) => item.id.startsWith(XFLOW_COLUMN_STEP_PREFIX) || item.output === outputName);
  const chain = stepsForOutput.map((step) => transformStepToChainStep(step, toXFlowType(column.type)));
  const defaultStep = chain.find((item) => item.operation === "Default Value");
  const nullGuardStep = chain.find((item) => item.operation === "Null Guard");
  const dataChain = chain.filter((item) => !FIELD_ONLY_OPERATIONS.has(item.operation));
  const dataStep = primaryTransformStep(dataChain);
  const transformDisplay = dataChain.map(formatChainStep).filter(Boolean).join(" -> ");

  return {
    defaultValue: defaultStep?.params ?? "",
    expandedFrom: column.expandedFrom,
    expandedIndex: column.expandedIndex,
    expandedTotal: column.expandedTotal,
    name: outputName,
    notNull: column.nullable === false || Boolean(nullGuardStep),
    onError: dataStep?.onError ?? defaultStep?.onError ?? nullGuardStep?.onError ?? "Warn",
    originalName: column.expandedFrom || column.sourceName,
    originalType: toXFlowType(column.type),
    reviewAnalysisInstruction: column.reviewAnalysisInstruction,
    reviewAnalysisMethod: column.reviewAnalysisMethod,
    sourceId: XFLOW_SOURCE_ID,
    sourceName: column.sourceName,
    transform: dataStep?.expression || (dataStep?.operation === "SQL Expression" ? dataStep.params : null),
    transformChain: dataChain,
    transformDisplay: transformDisplay || null,
    transformOperation: dataStep?.operation ?? null,
    transformParams: dataStep?.params ?? "",
    type: toXFlowType(column.type),
  };
}

function projectXFlowSchema(
  currentColumns: SchemaColumnDraft[],
  sampleRows: string[][],
  nextTargetSchema: XFlowColumn[],
  columnSteps: TransformStepDraft[],
) {
  const sourceIndexByName = buildSourceIndex(currentColumns);
  const usedSourceNames = new Set<string>();
  const currentTextExpansionKeys = new Set(
    currentColumns
      .filter((column) => column.expandedFrom && column.sourceName.startsWith("__text_analysis."))
      .map((column) => `${column.expandedFrom}:${column.targetName}`),
  );
  const hasNewTextExpansion = nextTargetSchema.some((target) => (
    target.expandedFrom && !currentTextExpansionKeys.has(`${target.expandedFrom}:${target.name}`)
  ));

  const targetColumns = nextTargetSchema.map((target) => {
    const sourceName = normalizeSourceName(target.originalName || target.name);
    const sourceIndex = sourceIndexByName.get(sourceName);
    const existing = sourceIndex === undefined ? undefined : currentColumns[sourceIndex];
    const chain = normalizeColumnChain(target, target.type);
    const displayRole = target.transformDisplay || chain.map(formatChainStep).filter(Boolean).join(" -> ") || target.transform || target.transformOperation || existing?.role;
    usedSourceNames.add(existing?.sourceName ?? sourceName);
    if (target.sourceName) usedSourceNames.add(target.sourceName);
    if (target.expandedFrom) usedSourceNames.add(target.expandedFrom);

    return {
      ...(existing ?? {
        confidence: 85,
        nullable: !target.notNull,
        sourceName,
      }),
      included: true,
      expandedFrom: target.expandedFrom,
      expandedIndex: target.expandedIndex,
      expandedTotal: target.expandedTotal,
      nullable: target.expandedFrom ? true : !target.notNull,
      role: displayRole ? `xflow-transform:${displayRole}` : existing?.role,
      reviewAnalysisInstruction: target.reviewAnalysisInstruction ?? existing?.reviewAnalysisInstruction,
      reviewAnalysisMethod: target.reviewAnalysisMethod ?? existing?.reviewAnalysisMethod,
      sourceName: target.expandedFrom
        ? `__text_analysis.${target.name}`
        : existing?.sourceName ?? sourceName,
      targetName: target.name,
      transformChain: chain,
      type: fromXFlowType(target.type),
    } satisfies SchemaColumnDraft;
  });

  const excludedColumns = currentColumns
    .filter((column) => !usedSourceNames.has(column.sourceName) && !isInternalDerivedColumn(column))
    .map((column) => ({
      ...column,
      included: hasNewTextExpansion && column.included !== false ? true : false,
    }));

  const nextColumns = [...targetColumns, ...excludedColumns];
  const nextRows = projectSampleRows(currentColumns, sampleRows, nextColumns, nextTargetSchema, columnSteps);

  return { nextColumns, nextRows };
}

function projectSampleRows(
  currentColumns: SchemaColumnDraft[],
  sampleRows: string[][],
  nextColumns: SchemaColumnDraft[],
  targetSchema: XFlowColumn[],
  columnSteps: TransformStepDraft[],
) {
  const sourceIndexByName = buildSourceIndex(currentColumns);
  const baseRows = sampleRows.map<TransformQualitySampleRow>((row, rowIndex) => {
    const record: TransformQualitySampleRow = { row_id: String(rowIndex + 1) };
    currentColumns.forEach((column, columnIndex) => {
      const value = row[columnIndex] ?? "";
      record[column.sourceName] = value;
      record[normalizeSourceName(column.sourceName)] = value;
      record[column.targetName || column.sourceName] = value;
      record[normalizeSourceName(column.targetName || column.sourceName)] = value;
    });
    targetSchema.forEach((target) => {
      const sourceName = normalizeSourceName(target.originalName || target.name);
      record[target.name] = record[target.name] ?? record[sourceName] ?? record[target.originalName || ""] ?? "";
      record[normalizeSourceName(target.name)] = record[normalizeSourceName(target.name)] ?? record[target.name] ?? "";
    });
    return record;
  });

  const previewSteps = columnSteps.filter((step) => step.id.startsWith(XFLOW_COLUMN_STEP_PREFIX));
  const transformedRows = runTransformQualitySamplePreview(previewSteps, [], baseRows).transformedRows;

  return transformedRows.map((row) => nextColumns.map((column) => {
    const sourceIndex = sourceIndexByName.get(normalizeSourceName(column.sourceName));
    const originalValue = sourceIndex === undefined ? "" : sampleRows[Number(row.row_id) - 1]?.[sourceIndex] ?? "";
    return row[column.targetName]
      ?? row[normalizeSourceName(column.targetName)]
      ?? row[column.sourceName]
      ?? row[normalizeSourceName(column.sourceName)]
      ?? originalValue;
  }));
}

function buildTransformSteps(targetSchema: XFlowColumn[]): TransformStepDraft[] {
  return targetSchema.flatMap((column) => {
    const output = column.name;
    const chain = normalizeColumnChain(column, column.type);
    let currentInput = initialTransformInput(column, chain);
    const steps: TransformStepDraft[] = [];

    chain.forEach((step, index) => {
      const params = step.params || step.expression || defaultParamsForOperation(step.operation);
      steps.push(makeTransformStep(column, currentInput, output, step.operation, params, index + 1, step.onError));
      currentInput = output;
    });

    if (column.defaultValue && !chain.some((step) => step.operation === "Default Value")) {
      steps.push(makeTransformStep(column, currentInput, output, "Default Value", column.defaultValue, steps.length + 1, "Warn"));
      currentInput = output;
    }

    const isTextRowAnalysisColumn = chain.some((step) => isTextRowAnalysisOperation(step.operation));
    if (column.notNull && !isTextRowAnalysisColumn && !chain.some((step) => step.operation === "Null Guard")) {
      steps.push(makeTransformStep(column, currentInput, output, "Null Guard", "required", steps.length + 1, "Fail Run"));
    }

    return steps;
  });
}

function initialTransformInput(column: XFlowColumn, chain: TransformChainStepDraft[]) {
  const firstDataStep = chain.find((step) => !FIELD_ONLY_OPERATIONS.has(step.operation));
  if (firstDataStep && isTextRowAnalysisOperation(firstDataStep.operation)) {
    return reviewAnalysisSourceFieldFromParams(firstDataStep.params)
      || column.expandedFrom
      || column.originalName
      || normalizeSourceName(column.sourceName || column.name);
  }
  return normalizeSourceName(column.name);
}

function reviewAnalysisSourceFieldFromParams(params = "") {
  try {
    const parsed = JSON.parse(params);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    return String(
      parsed.sourceField
      || parsed.textField
      || parsed.inputField
      || parsed.sourceColumn
      || "",
    ).trim();
  } catch {
    return "";
  }
}

function makeTransformStep(
  column: XFlowColumn,
  input: string,
  output: string,
  operation: string,
  params: string,
  order: number,
  onError?: string,
): TransformStepDraft {
  return {
    enabled: true,
    id: `${XFLOW_COLUMN_STEP_PREFIX}${safeId(output)}-${String(order).padStart(2, "0")}-${safeId(operation)}`,
    input,
    kind: kindForOperation(operation),
    label: `${operation}: ${input} -> ${output}`,
    onError: onError || column.onError || "Warn",
    operation,
    output,
    params,
  };
}

function mergeXFlowColumnSteps(existingSteps: TransformStepDraft[], nextColumnSteps: TransformStepDraft[]) {
  return [
    ...existingSteps.filter((step) => !step.id.startsWith(XFLOW_COLUMN_STEP_PREFIX)),
    ...nextColumnSteps,
  ];
}

function upsertSqlTransformStep(existingSteps: TransformStepDraft[], sql: string, sourceFormat: string) {
  const rest = existingSteps.filter((step) => step.id !== XFLOW_SQL_STEP_ID);
  if (!sql.trim()) return rest;
  return [
    ...rest,
    {
      enabled: true,
      id: XFLOW_SQL_STEP_ID,
      input: "input",
      kind: "derive",
      label: "SQL Transform",
      onError: "Warn",
      operation: "SQL Expression",
      output: `${safeId(sourceFormat || "source")}_sql_output`,
      params: sql.trim(),
    } satisfies TransformStepDraft,
  ];
}

function getInitialCustomSql(transformSteps: TransformStepDraft[]) {
  return transformSteps.find((step) => step.id === XFLOW_SQL_STEP_ID)?.params ?? "";
}

function normalizeColumnChain(column: XFlowColumn, fallbackType: string): TransformChainStepDraft[] {
  if (Array.isArray(column.transformChain) && column.transformChain.length > 0) {
    return column.transformChain
      .filter((step) => step && (step.operation || step.params || step.expression))
      .map((step) => normalizeChainStep(step, fallbackType))
      .filter((step) => !FIELD_ONLY_OPERATIONS.has(step.operation));
  }

  const chain: TransformChainStepDraft[] = [];
  if (column.transformOperation || column.transform) {
    const operation = column.transformOperation || "SQL Expression";
    chain.push(normalizeChainStep({
      display: column.transformDisplay || undefined,
      expression: column.transform || undefined,
      onError: column.onError,
      operation,
      params: column.transformParams || column.transform || defaultParamsForOperation(operation),
      type: column.type,
    }, fallbackType));
  }
  return chain;
}

function normalizeChainStep(step: TransformChainStepDraft, fallbackType: string): TransformChainStepDraft {
  const operation = step.operation || "SQL Expression";
  const params = step.params ?? step.expression ?? "";
  return {
    display: step.display || (operation === "SQL Expression" ? params : `${operation}${params ? `: ${params}` : ""}`),
    expression: step.expression || (operation === "SQL Expression" ? params : ""),
    onError: step.onError || "Warn",
    operation,
    params,
    type: step.type || fallbackType,
  };
}

function transformStepToChainStep(step: TransformStepDraft, fallbackType: string): TransformChainStepDraft {
  return normalizeChainStep({
    display: step.operation === CUSTOM_CSV_CLASSIFIER
      ? formatCsvClassifierDisplay(step.params)
      : isTextRowAnalysisOperation(step.operation)
        ? formatReviewRowAnalysisDisplay(step.params, step.output)
      : `${step.operation}${step.params ? `: ${step.params}` : ""}`,
    expression: step.operation === "SQL Expression"
      ? step.params
      : expressionForOperation(step.operation, step.input || step.output, step.params),
    onError: step.onError,
    operation: step.operation,
    params: step.params,
    type: fallbackType,
  }, fallbackType);
}

function primaryTransformStep(chain: TransformChainStepDraft[]) {
  return chain.find((step) => !FIELD_ONLY_OPERATIONS.has(step.operation)) ?? null;
}

function formatChainStep(step: TransformChainStepDraft) {
  if (step.display) return step.display;
  if (step.operation === "SQL Expression") return step.params || step.expression || "SQL Expression";
  return `${step.operation}${step.params ? `: ${step.params}` : ""}`;
}

function buildSourceIndex(columns: SchemaColumnDraft[]) {
  const sourceIndexByName = new Map<string, number>();
  columns.forEach((column, index) => {
    sourceIndexByName.set(column.sourceName, index);
    sourceIndexByName.set(normalizeSourceName(column.sourceName), index);
    sourceIndexByName.set(column.targetName || column.sourceName, index);
    sourceIndexByName.set(normalizeSourceName(column.targetName || column.sourceName), index);
  });
  return sourceIndexByName;
}

function expressionForOperation(operation: string, input: string, params = "") {
  switch (operation) {
    case TEXT_ROW_ANALYSIS:
      return `TEXT_ANALYZE(${quoteSqlIdentifier(input)})`;
    case REVIEW_ROW_ANALYSIS:
      return `REVIEW_ANALYZE(${quoteSqlIdentifier(input)})`;
    case CUSTOM_CSV_CLASSIFIER:
      return buildCsvClassifierSql(params, input);
    case "Extract JSONPath":
      return `get_json_object(CAST(${quoteSqlIdentifier(input)} AS STRING), '${params || "$.value"}')`;
    case "Lowercase + Trim":
      return `LOWER(TRIM(CAST(${quoteSqlIdentifier(input)} AS STRING)))`;
    case "Cast Decimal":
      return `CAST(${quoteSqlIdentifier(input)} AS DOUBLE)`;
    case "Parse Timestamp":
      return `TO_TIMESTAMP(CAST(${quoteSqlIdentifier(input)} AS STRING))`;
    case "Mask":
      return `REGEXP_REPLACE(CAST(${quoteSqlIdentifier(input)} AS STRING), '(\\\\d{3})-\\\\d{4}-(\\\\d{4})', '$1-****-$2')`;
    default:
      return quoteSqlIdentifier(input);
  }
}

function defaultParamsForOperation(operation: string) {
  switch (operation) {
    case "Extract JSONPath":
      return "$.value";
    case "Cast Decimal":
      return "double";
    case "Parse Timestamp":
      return "UTC";
    case "Mask":
      return "phone";
    case "Lowercase + Trim":
      return "lower(), trim()";
    case "Null Guard":
      return "required";
    default:
      return "";
  }
}

function kindForOperation(operation: string): TransformStepDraft["kind"] {
  const normalized = operation.toLowerCase();
  if (normalized.includes("json")) return "jsonPath";
  if (normalized.includes("mask")) return "mask";
  if (normalized.includes("trim") || normalized.includes("lower")) return "trim";
  if (normalized.includes("cast") || normalized.includes("decimal") || normalized.includes("timestamp")) return "cast";
  return "derive";
}

function normalizeSourceName(value: string) {
  return value.replace(/\./g, "_");
}

function safeId(value: string) {
  return normalizeSourceName(value).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "step";
}

function isInternalDerivedColumn(column: SchemaColumnDraft) {
  return column.sourceName.startsWith("__review_analysis.") || column.sourceName.startsWith("__text_analysis.");
}

function parseCsvClassifierConfig(params: string, input: string) {
  try {
    const parsed = JSON.parse(params);
    const rules: CsvClassifierRule[] = Array.isArray(parsed.rules)
      ? parsed.rules
        .map((rule: Record<string, unknown>) => ({
          condition: String(rule.condition || "keyword_any"),
          pattern: String(rule.pattern || ""),
          value: String(rule.value || "").trim(),
        }))
        .filter((rule: { value: string }) => rule.value)
      : [];
    return {
      fallbackValue: String(parsed.fallbackValue || rules.find((rule: { condition: string }) => rule.condition === "else")?.value || rules.at(-1)?.value || ""),
      rules,
      sourceField: String(parsed.sourceField || input),
    } satisfies CsvClassifierConfig;
  } catch {
    return { fallbackValue: "", rules: [], sourceField: input } satisfies CsvClassifierConfig;
  }
}

function formatCsvClassifierDisplay(params: string) {
  const config = parseCsvClassifierConfig(params, "");
  const values = config.rules.map((rule) => rule.value).join(" / ");
  return values ? `CSV classify: ${values}` : "CSV classify";
}

function formatReviewRowAnalysisDisplay(params: string, output: string) {
  try {
    const parsed = JSON.parse(params);
    const columns = Array.isArray(parsed.columns) ? parsed.columns : [];
    const label = columns.find((column: Record<string, unknown>) => column.targetName === output)?.instruction;
    return `Text row -> ${output}${label ? ` (${label})` : ""}`;
  } catch {
    return `Text row -> ${output}`;
  }
}

function isTextRowAnalysisOperation(operation: string) {
  return operation === REVIEW_ROW_ANALYSIS || operation === TEXT_ROW_ANALYSIS;
}

function buildCsvClassifierSql(params: string, input: string) {
  const config = parseCsvClassifierConfig(params, input);
  const sourceField = input || config.sourceField;
  const fallback = config.rules.find((rule) => rule.condition === "else")?.value
    || config.fallbackValue
    || config.rules.at(-1)?.value
    || "";
  const whenClauses = config.rules
    .filter((rule) => rule.condition !== "else")
    .map((rule) => `WHEN ${csvClassifierConditionSql(rule, sourceField)} THEN ${quoteSqlString(rule.value)}`);
  if (whenClauses.length === 0) return quoteSqlString(fallback);
  return `CASE ${whenClauses.join(" ")} ELSE ${quoteSqlString(fallback)} END`;
}

function csvClassifierConditionSql(rule: CsvClassifierRule, sourceField: string) {
  const source = quoteSqlIdentifier(sourceField);
  const lowered = `LOWER(CAST(${source} AS STRING))`;
  if (rule.condition === "empty") return `(${source} IS NULL OR LENGTH(TRIM(CAST(${source} AS STRING))) = 0)`;
  if (rule.condition === "not_empty") return `(${source} IS NOT NULL AND LENGTH(TRIM(CAST(${source} AS STRING))) > 0)`;
  if (rule.condition === "numeric_lte") return `CAST(${source} AS DOUBLE) <= ${Number(rule.pattern) || 0}`;
  if (rule.condition === "numeric_gte") return `CAST(${source} AS DOUBLE) >= ${Number(rule.pattern) || 0}`;
  const keywords = String(rule.pattern || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (keywords.length === 0) return "FALSE";
  if (rule.condition === "keyword_all") {
    return keywords.map((keyword) => `${lowered} RLIKE ${quoteSqlString(escapeRegex(keyword.toLowerCase()))}`).join(" AND ");
  }
  return `${lowered} RLIKE ${quoteSqlString(keywords.map((keyword) => escapeRegex(keyword.toLowerCase())).join("|"))}`;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteSqlIdentifier(value: string) {
  return `\`${value.replace(/`/g, "``")}\``;
}

function quoteSqlString(value: string) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function toXFlowType(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "integer" || normalized === "int") return "integer";
  if (normalized === "long" || normalized === "bigint") return "long";
  if (normalized === "float") return "float";
  if (normalized === "double" || normalized === "number") return "double";
  if (normalized === "boolean" || normalized === "bool") return "boolean";
  if (normalized === "timestamp" || normalized === "datetime") return "timestamp";
  if (normalized === "date") return "date";
  return "string";
}

function fromXFlowType(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "integer") return "Integer";
  if (normalized === "long") return "Long";
  if (normalized === "float") return "Float";
  if (normalized === "double") return "Double";
  if (normalized === "boolean") return "Boolean";
  if (normalized === "timestamp") return "Timestamp";
  if (normalized === "date") return "Date";
  return "String";
}
