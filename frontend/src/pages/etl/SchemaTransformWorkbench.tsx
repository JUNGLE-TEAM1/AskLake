import { useEffect, useMemo } from "react";
import SchemaTransformEditor from "../../components/etl/SchemaTransformEditor.jsx";
import "../../styles/schema-transform-source.css";
import "../../styles/schema-transform-adapter.css";
import type {
  KafkaExecutionMode,
  QualityRuleDraft,
  SchemaColumnDraft,
  TransformChainStepDraft,
  TransformStepDraft,
} from "../../types";

type SchemaTransformColumn = {
  defaultValue?: string;
  name: string;
  notNull?: boolean;
  nullGuardExplicit?: boolean;
  onError?: string;
  originalName?: string;
  originalType?: string;
  sourceId?: string | null;
  sourceName?: string;
  transform?: string | null;
  transformChain?: TransformChainStepDraft[];
  transformDisplay?: string | null;
  transformOperation?: string | null;
  transformParams?: string;
  type: string;
};

type SchemaTransformWorkbenchProps = {
  columns: SchemaColumnDraft[];
  executionMode?: KafkaExecutionMode;
  sampleRows: string[][];
  selectedIndex: number;
  sourceFormat: string;
  sourceType: string;
  qualityRules?: QualityRuleDraft[];
  transformSteps?: TransformStepDraft[];
  onColumnsChange: (columns: SchemaColumnDraft[], sampleRows?: string[][]) => void;
  onQualityRulesChange?: (rules: QualityRuleDraft[]) => void;
  onSelectedIndexChange: (index: number) => void;
  onTransformStepsChange?: (steps: TransformStepDraft[], outputColumns: Array<[string, string]>) => void;
};

const SCHEMA_TRANSFORM_SOURCE_ID = "asklake-source";
const SCHEMA_TRANSFORM_DATASET_ID = "asklake-draft-source";
const FIELD_OPERATIONS = new Set(["rename", "cast", "default_value", "null_guard"]);

export function SchemaTransformWorkbench({
  columns,
  executionMode = "snapshot",
  sampleRows,
  selectedIndex,
  sourceFormat,
  sourceType,
  qualityRules = [],
  transformSteps = [],
  onColumnsChange,
  onQualityRulesChange,
  onSelectedIndexChange,
  onTransformStepsChange,
}: SchemaTransformWorkbenchProps) {
  const isKafka = sourceType.toLowerCase().includes("kafka");
  const continuous = executionMode === "continuous";

  const sourceSchema = useMemo(() => columns.map((column) => ({
    field: column.sourceName,
    name: column.sourceName,
    type: toSchemaTransformType(column.sourceType ?? column.type),
  })), [columns]);

  const targetSchema = useMemo(
    () => columns
      .filter((column) => column.included !== false)
      .sort((left, right) => (left.targetOrder ?? columns.indexOf(left)) - (right.targetOrder ?? columns.indexOf(right)))
      .map((column) => toSchemaTransformTargetColumn(column, transformSteps)),
    [columns, transformSteps],
  );

  const effectiveTransformSteps = useMemo(
    () => ensureRequiredFieldTransformSteps(targetSchema, transformSteps),
    [targetSchema, transformSteps],
  );

  const allSources = useMemo(() => [{
    datasetId: SCHEMA_TRANSFORM_DATASET_ID,
    id: SCHEMA_TRANSFORM_SOURCE_ID,
    name: sourceFormat || "Source",
    schema: sourceSchema,
    sourceType: sourceFormat?.toLowerCase?.() ?? "source",
  }], [sourceFormat, sourceSchema]);

  useEffect(() => {
    if (effectiveTransformSteps === transformSteps) return;
    onTransformStepsChange?.(effectiveTransformSteps, outputColumnsFromTargetSchema(targetSchema));
  }, [effectiveTransformSteps, onTransformStepsChange, targetSchema, transformSteps]);

  const handleSchemaChange = (nextTargetSchema: SchemaTransformColumn[]) => {
    const { nextColumns, nextRows } = projectSchemaTransformSchema(columns, sampleRows, nextTargetSchema);
    const nextSteps = buildTransformSteps(nextTargetSchema);
    onColumnsChange(nextColumns, nextRows);
    onSelectedIndexChange(Math.min(selectedIndex, Math.max(nextColumns.length - 1, 0)));
    onTransformStepsChange?.(nextSteps, outputColumnsFromTargetSchema(nextTargetSchema));
  };

  const handleSqlChange = (sql: string, mode?: string) => {
    if (mode !== "sql" || !sql.trim() || continuous || isKafka) return;
    const firstColumn = columns.find((column) => column.included !== false);
    if (!firstColumn) return;
    const output = firstColumn.targetName || firstColumn.sourceName;
    onTransformStepsChange?.(ensureRequiredFieldTransformSteps(targetSchema, [
      {
        canonicalParameters: { expression: sql },
        enabled: true,
        id: "schema-transform-sql",
        input: firstColumn.sourceName,
        kind: "derive",
        label: "SQL Transform",
        onError: "Warn",
        operation: "SQL Expression",
        output,
        params: sql,
      },
    ]), outputColumnsFromTargetSchema(targetSchema));
  };

  return (
    <div className="asklake-schema-transform-adapter">
      <div className="asklake-schema-transform-scroll-frame">
        <SchemaTransformEditor
          allSources={allSources}
          allowSqlTransform={!continuous && !isKafka}
          initialCustomSql={transformSteps.find((step) => step.operation === "SQL Expression")?.params ?? ""}
          initialTargetSchema={targetSchema}
          qualityRules={qualityRules}
          onSchemaChange={handleSchemaChange}
          onQualityRulesChange={onQualityRulesChange}
          onSqlChange={handleSqlChange}
          onTestStatusChange={() => undefined}
          portableTransforms={continuous || isKafka}
          sourceDatasetId={SCHEMA_TRANSFORM_DATASET_ID}
          sourceId={SCHEMA_TRANSFORM_SOURCE_ID}
          sourceName={sourceFormat || "Source"}
          sourceSampleRows={sampleRows}
          sourceSchema={sourceSchema}
          sourceTabs={null}
          targetSchema={targetSchema}
          transformsDisabled={false}
        />
      </div>
    </div>
  );
}

function toSchemaTransformTargetColumn(column: SchemaColumnDraft, transformSteps: TransformStepDraft[]): SchemaTransformColumn {
  const outputName = column.targetName ?? column.sourceName;
  const relatedSteps = transformSteps.filter((step) => step.output === outputName);
  const defaultStep = relatedSteps.find((step) => normalizeLegacyOperation(step.operation) === "default_value");
  const nullGuardStep = relatedSteps.find((step) => normalizeLegacyOperation(step.operation) === "null_guard");
  const dataSteps = relatedSteps.filter((step) => !FIELD_OPERATIONS.has(normalizeLegacyOperation(step.operation)));
  const primaryStep = dataSteps[0];
  const transformChain = dataSteps.map((step) => ({
    display: normalizeLegacyOperation(step.operation) === "sql_expression" ? step.params : step.label,
    expression: normalizeLegacyOperation(step.operation) === "sql_expression" ? step.params : "",
    onError: step.onError,
    operation: step.operation,
    params: step.params,
    type: toSchemaTransformType(column.type),
  }));
  return {
    defaultValue: defaultStep ? String(defaultStep.canonicalParameters?.value ?? defaultStep.params ?? "") : "",
    name: outputName,
    notNull: column.nullable === false || Boolean(nullGuardStep),
    nullGuardExplicit: Boolean(nullGuardStep),
    onError: primaryStep?.onError ?? "Warn",
    originalName: column.sourceName,
    originalType: toSchemaTransformType(column.sourceType ?? column.type),
    sourceId: SCHEMA_TRANSFORM_SOURCE_ID,
    sourceName: "Source",
    transform: normalizeLegacyOperation(primaryStep?.operation ?? "") === "sql_expression" ? primaryStep?.params ?? null : null,
    transformChain,
    transformDisplay: transformChain.map((step) => step.display).filter(Boolean).join(" -> ") || null,
    transformOperation: primaryStep?.operation ?? null,
    transformParams: primaryStep?.params ?? "",
    type: toSchemaTransformType(column.type),
  };
}

function projectSchemaTransformSchema(
  currentColumns: SchemaColumnDraft[],
  sampleRows: string[][],
  nextTargetSchema: SchemaTransformColumn[],
) {
  const targetBySourceName = new Map<string, { order: number; target: SchemaTransformColumn }>();
  nextTargetSchema.forEach((target, order) => {
    const sourceName = target.originalName || target.name;
    if (!targetBySourceName.has(sourceName)) targetBySourceName.set(sourceName, { order, target });
  });

  const nextColumns = currentColumns.map((column) => {
    const selected = targetBySourceName.get(column.sourceName);
    if (!selected) return { ...column, included: false, targetOrder: undefined };
    const { order, target } = selected;
    return {
      ...column,
      included: true,
      nullable: !target.notNull,
      role: target.transformOperation ? `schema-transform:${target.transformOperation}` : column.role,
      sourceType: column.sourceType ?? column.type,
      targetName: target.name,
      targetOrder: order,
      transformChain: target.transformChain,
      type: fromSchemaTransformType(target.type),
    } satisfies SchemaColumnDraft;
  });
  const nextRows = sampleRows.map((row) => [...row]);

  return { nextColumns, nextRows };
}

export function buildTransformSteps(targetSchema: SchemaTransformColumn[]): TransformStepDraft[] {
  return targetSchema.flatMap((column, columnIndex) => {
    const output = column.name.trim();
    if (!output) return [];
    const source = (column.originalName || column.name).trim();
    const sourceType = fromSchemaTransformType(column.originalType || column.type);
    const outputType = fromSchemaTransformType(column.type);
    const slug = ruleSlug(`${source}-${output}-${columnIndex}`);
    const steps: TransformStepDraft[] = [];
    let currentInput = source;

    if (source !== output) {
      steps.push(transformStep({
        id: `schema-${slug}-rename`,
        input: source,
        kind: "rename",
        operation: "Rename",
        output,
        outputType,
        parameters: {},
      }));
      currentInput = output;
    }

    if (canonicalType(sourceType) !== canonicalType(outputType)) {
      steps.push(transformStep({
        id: `schema-${slug}-cast`,
        input: currentInput,
        kind: "cast",
        operation: `Cast ${outputType}`,
        output,
        outputType,
        parameters: { targetType: canonicalType(outputType) },
      }));
      currentInput = output;
    }

    for (const [chainIndex, chainStep] of (column.transformChain ?? []).entries()) {
      const operation = normalizeLegacyOperation(chainStep.operation);
      if (!operation || FIELD_OPERATIONS.has(operation)) continue;
      steps.push(transformStep({
        id: `schema-${slug}-${ruleSlug(operation)}-${chainIndex + 1}`,
        input: currentInput,
        kind: transformKind(operation),
        onError: chainStep.onError,
        operation: legacyOperationLabel(operation),
        output,
        outputType,
        parameters: canonicalParameters(operation, chainStep.params, outputType),
      }));
      currentInput = output;
    }

    if (column.defaultValue !== undefined && column.defaultValue !== "") {
      steps.push(transformStep({
        id: `schema-${slug}-default`,
        input: currentInput,
        kind: "derive",
        operation: "Default Value",
        output,
        outputType,
        parameters: { value: column.defaultValue },
      }));
      currentInput = output;
    }

    if (column.notNull && column.nullGuardExplicit) {
      steps.push(transformStep({
        id: `schema-${slug}-null-guard`,
        input: currentInput,
        kind: "derive",
        onError: "Fail Run",
        operation: "Null Guard",
        output,
        outputType,
        parameters: {},
      }));
    }
    return steps;
  });
}

export function ensureRequiredFieldTransformSteps(
  targetSchema: SchemaTransformColumn[],
  currentSteps: TransformStepDraft[],
): TransformStepDraft[] {
  const requiredSteps = buildTransformSteps(targetSchema).filter((step) => {
    const operation = normalizeLegacyOperation(step.operation);
    return operation === "rename" || operation === "cast";
  });
  const currentFieldSteps = currentSteps.filter((step) => {
    const operation = normalizeLegacyOperation(step.operation);
    return operation === "rename" || operation === "cast";
  });
  const fieldsAreOrdered = currentFieldSteps.length === requiredSteps.length
    && currentFieldSteps.every((step, index) => sameRequiredFieldStep(step, requiredSteps[index]));
  const fieldsLeadPipeline = currentSteps.slice(0, requiredSteps.length).every((step) => {
    const operation = normalizeLegacyOperation(step.operation);
    return operation === "rename" || operation === "cast";
  });
  if (fieldsAreOrdered && fieldsLeadPipeline) {
    return currentSteps;
  }
  const nonFieldSteps = currentSteps.filter((step) => {
    const operation = normalizeLegacyOperation(step.operation);
    return operation !== "rename" && operation !== "cast";
  });
  return [...requiredSteps, ...nonFieldSteps];
}

function sameRequiredFieldStep(left: TransformStepDraft, right: TransformStepDraft) {
  if (normalizeLegacyOperation(left.operation) !== normalizeLegacyOperation(right.operation)) return false;
  if (left.input !== right.input || left.output !== right.output) return false;
  if (normalizeLegacyOperation(right.operation) !== "cast") return true;
  return canonicalType(String(left.canonicalParameters?.targetType ?? left.params))
    === canonicalType(String(right.canonicalParameters?.targetType ?? right.params));
}

function transformStep({
  id,
  input,
  kind,
  onError = "Warn",
  operation,
  output,
  outputType,
  parameters,
}: {
  id: string;
  input: string;
  kind: TransformStepDraft["kind"];
  onError?: string;
  operation: string;
  output: string;
  outputType: string;
  parameters: Record<string, unknown>;
}): TransformStepDraft {
  return {
    canonicalParameters: parameters,
    enabled: true,
    id,
    input,
    kind,
    label: `${operation}: ${input} -> ${output}`,
    onError,
    operation,
    output,
    params: legacyParams(parameters, outputType),
  };
}

function canonicalParameters(operation: string, params: string, outputType: string) {
  if (operation === "json_extract") return { path: params || "$.value" };
  if (operation === "mask") return { policy: params || "phone" };
  if (operation === "parse_timestamp") return { format: params || "ISO-8601" };
  if (operation === "sql_expression") return { expression: params };
  if (operation === "cast") return { targetType: canonicalType(outputType) };
  return {};
}

function legacyParams(parameters: Record<string, unknown>, outputType: string) {
  if ("path" in parameters) return String(parameters.path ?? "$.value");
  if ("policy" in parameters) return String(parameters.policy ?? "phone");
  if ("format" in parameters) return String(parameters.format ?? "ISO-8601");
  if ("expression" in parameters) return String(parameters.expression ?? "");
  if ("value" in parameters) return String(parameters.value ?? "");
  if ("targetType" in parameters) return String(parameters.targetType ?? outputType);
  return "";
}

function normalizeLegacyOperation(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  if (normalized.includes("sql_expression")) return "sql_expression";
  if (normalized.includes("default")) return "default_value";
  if (normalized.includes("null_guard") || normalized.includes("not_null")) return "null_guard";
  if (normalized.includes("json")) return "json_extract";
  if (normalized.includes("lower") || normalized.includes("trim")) return "lowercase_trim";
  if (normalized.includes("timestamp")) return "parse_timestamp";
  if (normalized.includes("mask")) return "mask";
  if (normalized.includes("rename")) return "rename";
  if (normalized.includes("cast")) return "cast";
  if (normalized.includes("copy")) return "copy";
  return normalized;
}

function legacyOperationLabel(operation: string) {
  return ({
    copy: "Copy",
    json_extract: "Extract JSONPath",
    lowercase_trim: "Lowercase + Trim",
    mask: "Mask",
    parse_timestamp: "Parse Timestamp",
    sql_expression: "SQL Expression",
  } as Record<string, string>)[operation] ?? operation;
}

function transformKind(operation: string): TransformStepDraft["kind"] {
  if (operation === "json_extract") return "jsonPath";
  if (operation === "lowercase_trim") return "trim";
  if (operation === "mask") return "mask";
  if (operation === "parse_timestamp") return "cast";
  return "derive";
}

function outputColumnsFromTargetSchema(targetSchema: SchemaTransformColumn[]): Array<[string, string]> {
  return targetSchema.map((column) => [column.name, canonicalType(fromSchemaTransformType(column.type))]);
}

function ruleSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "column";
}

function canonicalType(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "integer" || normalized === "int") return "Integer";
  if (normalized === "long" || normalized === "bigint" || normalized === "int64") return "Long";
  if (["float", "float32", "float64", "double", "decimal", "number"].includes(normalized)) return "Double";
  if (normalized === "boolean" || normalized === "bool") return "Boolean";
  if (normalized === "timestamp" || normalized === "datetime") return "Timestamp";
  if (normalized === "date") return "Date";
  if (["json", "array", "struct", "map", "object"].includes(normalized)) return "JSON";
  return "String";
}

function toSchemaTransformType(type: string) {
  return canonicalType(type).toLowerCase();
}

function fromSchemaTransformType(type: string) {
  return canonicalType(type);
}
