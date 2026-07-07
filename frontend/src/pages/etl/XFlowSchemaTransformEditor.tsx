import { useMemo } from "react";
import SchemaTransformEditor from "../../components/etl/SchemaTransformEditor.jsx";
import "../../styles/xflow-source.css";
import "../../styles/xflow-adapter.css";
import type { SchemaColumnDraft, TransformStepDraft } from "../../types";

type XFlowColumn = {
  defaultValue?: string;
  name: string;
  notNull?: boolean;
  originalName?: string;
  originalType?: string;
  sourceId?: string | null;
  sourceName?: string;
  transform?: string | null;
  transformDisplay?: string | null;
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

const XFLOW_SOURCE_ID = "asklake-source";
const XFLOW_DATASET_ID = "asklake-draft-source";

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
  const sourceSchema = useMemo(() => columns.map((column) => ({
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
    const { nextColumns, nextRows } = projectXFlowSchema(columns, sampleRows, nextTargetSchema);
    onColumnsChange(nextColumns, nextRows);
    onSelectedIndexChange(Math.min(selectedIndex, Math.max(nextColumns.length - 1, 0)));
    onTransformStepsChange?.(buildTransformSteps(nextTargetSchema));
  };

  const handleSqlChange = (sql: string) => {
    if (!sql.trim()) return;
    onTransformStepsChange?.([
      {
        enabled: true,
        id: "xflow-sql-transform",
        input: sourceFormat || "source",
        kind: "derive",
        label: "SQL Transform",
        onError: "Warn",
        operation: "SQL Expression",
        output: "xflow_sql_output",
        params: sql,
      },
    ]);
  };

  return (
    <div className="asklake-xflow-source-adapter">
      <div className="asklake-xflow-scroll-frame">
        <SchemaTransformEditor
          allSources={allSources}
          initialCustomSql=""
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
  const step = transformSteps.find((item) => item.output === outputName);
  return {
    defaultValue: step?.operation === "Default Value" ? step.params : "",
    name: outputName,
    notNull: column.nullable === false || step?.operation === "Null Guard",
    originalName: column.sourceName,
    originalType: toXFlowType(column.type),
    sourceId: XFLOW_SOURCE_ID,
    sourceName: "Source",
    transform: step?.operation === "SQL Expression" ? step.params : null,
    transformDisplay: step?.operation === "SQL Expression" ? step.params : null,
    type: toXFlowType(column.type),
  };
}

function projectXFlowSchema(
  currentColumns: SchemaColumnDraft[],
  sampleRows: string[][],
  nextTargetSchema: XFlowColumn[],
) {
  const sourceIndexByName = new Map(currentColumns.map((column, index) => [column.sourceName, index]));
  const usedSourceNames = new Set<string>();

  const targetColumns = nextTargetSchema.map((target) => {
    const sourceName = normalizeSourceName(target.originalName || target.name);
    const sourceIndex = sourceIndexByName.get(sourceName);
    const existing = sourceIndex === undefined ? undefined : currentColumns[sourceIndex];
    usedSourceNames.add(existing?.sourceName ?? sourceName);

    return {
      ...(existing ?? {
        confidence: 85,
        nullable: !target.notNull,
        sourceName,
      }),
      included: true,
      nullable: !target.notNull,
      role: target.transform ? `xflow-transform:${target.transform}` : existing?.role,
      sourceName: existing?.sourceName ?? sourceName,
      targetName: target.name,
      type: fromXFlowType(target.type),
    } satisfies SchemaColumnDraft;
  });

  const excludedColumns = currentColumns
    .filter((column) => !usedSourceNames.has(column.sourceName))
    .map((column) => ({ ...column, included: false }));

  const nextColumns = [...targetColumns, ...excludedColumns];
  const nextRows = sampleRows.map((row) => nextColumns.map((column) => {
    const sourceIndex = sourceIndexByName.get(column.sourceName);
    return sourceIndex === undefined ? "" : row[sourceIndex] ?? "";
  }));

  return { nextColumns, nextRows };
}

function buildTransformSteps(targetSchema: XFlowColumn[]): TransformStepDraft[] {
  return targetSchema.flatMap((column) => {
    const output = column.name;
    const input = normalizeSourceName(column.originalName || column.name);
    if (column.transform) {
      return [{
        enabled: true,
        id: `xflow-${output}`,
        input,
        kind: "derive",
        label: `SQL Expression: ${output}`,
        onError: "Warn",
        operation: "SQL Expression",
        output,
        params: column.transform,
      } satisfies TransformStepDraft];
    }
    if (column.defaultValue) {
      return [{
        enabled: true,
        id: `xflow-${output}`,
        input,
        kind: "derive",
        label: `Default Value: ${output}`,
        onError: "Warn",
        operation: "Default Value",
        output,
        params: column.defaultValue,
      } satisfies TransformStepDraft];
    }
    if (column.notNull) {
      return [{
        enabled: true,
        id: `xflow-${output}`,
        input,
        kind: "derive",
        label: `Null Guard: ${output}`,
        onError: "Warn",
        operation: "Null Guard",
        output,
        params: "required",
      } satisfies TransformStepDraft];
    }
    return [];
  });
}

function normalizeSourceName(value: string) {
  return value.replace(/\./g, "_");
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
