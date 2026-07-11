import { useMemo } from "react";
import SchemaTransformEditor from "../../components/etl/SchemaTransformEditor.jsx";
import "../../styles/schema-transform-source.css";
import "../../styles/schema-transform-adapter.css";
import type { SchemaColumnDraft, TransformStepDraft } from "../../types";

type SchemaTransformColumn = {
  defaultValue?: string;
  isAdded?: boolean;
  name: string;
  notNull?: boolean;
  onError?: string;
  originalName?: string;
  originalType?: string;
  sourceId?: string | null;
  sourceName?: string;
  transform?: string | null;
  transformChain?: Array<{
    display?: string;
    expression?: string;
    onError?: string;
    operation: string;
    params?: string;
    type?: string;
  }>;
  transformDisplay?: string | null;
  transformOperation?: string | null;
  transformParams?: string;
  type: string;
};

type SchemaTransformWorkbenchProps = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  selectedIndex: number;
  sourceFormat: string;
  transformSteps?: TransformStepDraft[];
  onColumnsChange: (columns: SchemaColumnDraft[], sampleRows?: string[][]) => void;
  onSelectedIndexChange: (index: number) => void;
  onTransformStepsChange?: (steps: TransformStepDraft[]) => void;
};

const SCHEMA_TRANSFORM_SOURCE_ID = "asklake-source";
const SCHEMA_TRANSFORM_DATASET_ID = "asklake-draft-source";

export function SchemaTransformWorkbench({
  columns,
  sampleRows,
  selectedIndex,
  sourceFormat,
  transformSteps = [],
  onColumnsChange,
  onSelectedIndexChange,
  onTransformStepsChange,
}: SchemaTransformWorkbenchProps) {
  const sourceSchema = useMemo(() => columns
    .filter((column) => column.role !== "schema-added")
    .map((column) => ({
      field: column.sourceName,
      name: column.sourceName,
      type: toSchemaTransformType(column.type),
    })), [columns]);

  const targetSchema = useMemo(
    () => columns
      .filter((column) => column.included !== false)
      .sort((left, right) => (left.targetOrder ?? columns.indexOf(left)) - (right.targetOrder ?? columns.indexOf(right)))
      .map((column) => toSchemaTransformTargetColumn(column, transformSteps)),
    [columns, transformSteps],
  );

  const allSources = useMemo(() => [{
    datasetId: SCHEMA_TRANSFORM_DATASET_ID,
    id: SCHEMA_TRANSFORM_SOURCE_ID,
    name: sourceFormat || "Source",
    schema: sourceSchema,
    sourceType: sourceFormat?.toLowerCase?.() ?? "source",
  }], [sourceFormat, sourceSchema]);

  const handleSchemaChange = (nextTargetSchema: SchemaTransformColumn[]) => {
    const { nextColumns, nextRows } = projectSchemaTransformSchema(columns, sampleRows, nextTargetSchema);
    onColumnsChange(nextColumns, nextRows);
    onSelectedIndexChange(Math.min(selectedIndex, Math.max(nextColumns.length - 1, 0)));
    onTransformStepsChange?.(buildTransformSteps(nextTargetSchema));
  };

  const handleSqlChange = (sql: string, mode?: string) => {
    if (mode !== "sql" || !sql.trim()) return;
    onTransformStepsChange?.([
      {
        enabled: true,
        id: "schema-transform-sql",
        input: sourceFormat || "source",
        kind: "derive",
        label: "SQL Transform",
        onError: "Warn",
        operation: "SQL Expression",
        output: "schema_transform_sql_output",
        params: sql,
      },
    ]);
  };

  return (
    <div className="asklake-schema-transform-adapter">
      <div className="asklake-schema-transform-scroll-frame">
        <SchemaTransformEditor
          allSources={allSources}
          initialCustomSql=""
          initialTargetSchema={targetSchema}
          onSchemaChange={handleSchemaChange}
          onSqlChange={handleSqlChange}
          onTestStatusChange={() => undefined}
          sourceDatasetId={SCHEMA_TRANSFORM_DATASET_ID}
          sourceId={SCHEMA_TRANSFORM_SOURCE_ID}
          sourceName={sourceFormat || "Source"}
          sourceSchema={sourceSchema}
          sourceTabs={null}
          targetSchema={targetSchema}
        />
      </div>
    </div>
  );
}

function toSchemaTransformTargetColumn(column: SchemaColumnDraft, transformSteps: TransformStepDraft[]): SchemaTransformColumn {
  const outputName = column.targetName ?? column.sourceName;
  const steps = transformSteps.filter((item) => item.output === outputName && item.enabled !== false);
  const dataStep = steps.find((item) => !["Default Value", "Null Guard"].includes(item.operation));
  const defaultStep = steps.find((item) => item.operation === "Default Value");
  const nullGuardStep = steps.find((item) => item.operation === "Null Guard");
  return {
    defaultValue: defaultStep?.params ?? "",
    isAdded: column.role === "schema-added",
    name: outputName,
    notNull: column.nullable === false || Boolean(nullGuardStep),
    onError: dataStep?.onError ?? "Warn",
    originalName: column.sourceName,
    originalType: toSchemaTransformType(column.type),
    sourceId: SCHEMA_TRANSFORM_SOURCE_ID,
    sourceName: "Source",
    transform: dataStep?.operation === "SQL Expression" ? dataStep.params : null,
    transformChain: dataStep ? [{
      display: dataStep.operation === "SQL Expression" ? dataStep.params : `${dataStep.operation}: ${dataStep.params}`,
      expression: dataStep.operation === "SQL Expression" ? dataStep.params : "",
      onError: dataStep.onError,
      operation: dataStep.operation,
      params: dataStep.params,
      type: toSchemaTransformType(column.type),
    }] : [],
    transformDisplay: dataStep ? (dataStep.operation === "SQL Expression" ? dataStep.params : `${dataStep.operation}: ${dataStep.params}`) : null,
    transformOperation: dataStep?.operation ?? null,
    transformParams: dataStep?.params ?? "",
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
    const sourceName = normalizeSourceName(target.originalName || target.name);
    if (!targetBySourceName.has(sourceName)) targetBySourceName.set(sourceName, { order, target });
  });

  const retainedIndexes: number[] = [];
  const matchedOrders = new Set<number>();
  const nextColumns: SchemaColumnDraft[] = [];
  currentColumns.forEach((column, columnIndex) => {
    const selected = targetBySourceName.get(normalizeSourceName(column.sourceName));
    if (!selected && column.role === "schema-added") return;
    retainedIndexes.push(columnIndex);
    if (!selected) {
      nextColumns.push({ ...column, included: false, targetOrder: undefined });
      return;
    }
    const { order, target } = selected;
    matchedOrders.add(order);
    nextColumns.push({
      ...column,
      included: true,
      nullable: !target.notNull,
      targetName: target.name,
      targetOrder: order,
      type: fromSchemaTransformType(target.type),
    });
  });
  const nextRows = sampleRows.map((row) => retainedIndexes.map((index) => row[index] ?? ""));

  nextTargetSchema.forEach((target, order) => {
    if (matchedOrders.has(order)) return;
    const sourceName = String(target.originalName || target.name || `column_${order + 1}`).trim();
    nextColumns.push({
      confidence: 100,
      included: true,
      nullable: !target.notNull,
      role: "schema-added",
      sourceName,
      targetName: target.name || sourceName,
      targetOrder: order,
      type: fromSchemaTransformType(target.type),
    });
    nextRows.forEach((row) => row.push(""));
  });

  return { nextColumns, nextRows };
}

function buildTransformSteps(targetSchema: SchemaTransformColumn[]): TransformStepDraft[] {
  return targetSchema.flatMap((column) => {
    const output = column.name;
    const input = column.isAdded ? output : normalizeSourceName(column.originalName || column.name);
    const chainStep = column.transformChain?.find((step) => !["Default Value", "Null Guard"].includes(step.operation));
    const operation = chainStep?.operation || column.transformOperation || (column.transform ? "SQL Expression" : "");
    const params = chainStep?.params ?? column.transformParams ?? column.transform ?? "";
    const steps: TransformStepDraft[] = [];
    if (operation) {
      steps.push({
        enabled: true,
        id: `schema-transform-${output}-data`,
        input,
        kind: "derive",
        label: `${operation}: ${output}`,
        onError: chainStep?.onError || column.onError || "Warn",
        operation,
        output,
        params,
      });
    }
    if (column.defaultValue) {
      steps.push({
        enabled: true,
        id: `schema-transform-${output}-default`,
        input,
        kind: "derive",
        label: `Default Value: ${output}`,
        onError: "Warn",
        operation: "Default Value",
        output,
        params: column.defaultValue,
      });
    }
    if (column.notNull) {
      steps.push({
        enabled: true,
        id: `schema-transform-${output}-required`,
        input,
        kind: "derive",
        label: `Null Guard: ${output}`,
        onError: "Warn",
        operation: "Null Guard",
        output,
        params: "required",
      });
    }
    return steps;
  });
}

function normalizeSourceName(value: string) {
  return value.replace(/\./g, "_");
}

function toSchemaTransformType(type: string) {
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

function fromSchemaTransformType(type: string) {
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
