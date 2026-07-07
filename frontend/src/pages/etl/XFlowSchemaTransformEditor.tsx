import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Copy,
  FileText,
  Plus,
  Table2,
} from "lucide-react";
import type { SchemaColumnDraft, TransformStepDraft } from "../../types";

const TYPE_OPTIONS = ["String", "Integer", "Long", "Float", "Double", "Boolean", "Timestamp", "Date", "JSON"];

const TRANSFORM_OPTIONS = [
  { label: "No transform", operation: "", params: "", kind: "derive" },
  { label: "Number", operation: "Cast Number", params: "number", kind: "cast" },
  { label: "Integer", operation: "Cast Integer", params: "integer", kind: "cast" },
  { label: "String", operation: "Cast String", params: "string", kind: "cast" },
  { label: "Boolean", operation: "Cast Boolean", params: "boolean", kind: "cast" },
  { label: "Timestamp", operation: "Parse Timestamp", params: "yyyy-MM-dd HH:mm:ss", kind: "cast" },
] as const;

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
  const [selectedBefore, setSelectedBefore] = useState<Set<number>>(new Set());
  const [selectedAfter, setSelectedAfter] = useState<Set<number>>(new Set());

  const includedIndexes = useMemo(
    () => columns.map((column, index) => ({ column, index })).filter(({ column }) => column.included !== false),
    [columns],
  );

  const transformByOutput = useMemo(() => {
    const map = new Map<string, TransformStepDraft>();
    transformSteps.forEach((step) => {
      if (step.enabled !== false && step.output) {
        map.set(step.output, step);
      }
    });
    return map;
  }, [transformSteps]);

  const selectedBeforeCount = selectedBefore.size;
  const selectedAfterCount = selectedAfter.size;
  const selectedColumn = columns[selectedIndex];
  const selectedTransform = selectedColumn ? transformByOutput.get(getOutputName(selectedColumn)) : undefined;
  const selectedPreview = selectedColumn ? previewColumnSample(selectedColumn, sampleRows[0]?.[selectedIndex] ?? "", selectedTransform) : undefined;

  const updateColumns = (nextColumns: SchemaColumnDraft[], nextRows = sampleRows) => {
    onColumnsChange(nextColumns, nextRows);
  };

  const toggleBefore = (index: number) => {
    setSelectedBefore((current) => toggleSetValue(current, index));
    onSelectedIndexChange(index);
  };

  const toggleAfter = (index: number) => {
    setSelectedAfter((current) => toggleSetValue(current, index));
    onSelectedIndexChange(index);
  };

  const moveSelectedToRight = () => {
    if (selectedBefore.size === 0) return;
    const selected = new Set(selectedBefore);
    const nextColumns = columns.map((column, index) => (
      selected.has(index) ? { ...column, included: true } : column
    ));
    updateColumns(nextColumns);
    setSelectedBefore(new Set());
  };

  const moveAllToRight = () => {
    updateColumns(columns.map((column) => ({ ...column, included: true })));
    setSelectedBefore(new Set());
  };

  const moveSelectedToLeft = () => {
    if (selectedAfter.size === 0) return;
    const selected = new Set(selectedAfter);
    const removedOutputs = new Set(columns.filter((_, index) => selected.has(index)).map((column) => getOutputName(column)));
    const nextColumns = columns.map((column, index) => (
      selected.has(index) ? { ...column, included: false } : column
    ));
    updateColumns(nextColumns);
    setSelectedAfter(new Set());
    onTransformStepsChange?.(transformSteps.filter((step) => !removedOutputs.has(step.output)));
    const nextSelected = nextColumns.findIndex((column) => column.included !== false);
    onSelectedIndexChange(Math.max(0, nextSelected));
  };

  const moveAllToLeft = () => {
    updateColumns(columns.map((column) => ({ ...column, included: false })));
    setSelectedAfter(new Set());
    onTransformStepsChange?.([]);
    onSelectedIndexChange(0);
  };

  const updateColumn = (index: number, patch: Partial<SchemaColumnDraft>) => {
    const column = columns[index];
    if (!column) return;

    const beforeOutput = getOutputName(column);
    const nextColumns = columns.map((currentColumn, columnIndex) => (
      columnIndex === index ? { ...currentColumn, ...patch } : currentColumn
    ));
    updateColumns(nextColumns);
    onSelectedIndexChange(index);

    const afterOutput = getOutputName(nextColumns[index]);
    if (beforeOutput !== afterOutput && transformByOutput.has(beforeOutput)) {
      onTransformStepsChange?.(transformSteps.map((step) => (
        step.output === beforeOutput ? { ...step, id: `schema-${afterOutput}`, output: afterOutput, label: `${step.operation}: ${afterOutput}` } : step
      )));
    }
  };

  const updateTransform = (index: number, operation: string) => {
    const column = columns[index];
    if (!column) return;

    const output = getOutputName(column);
    const remainingSteps = transformSteps.filter((step) => step.output !== output);
    if (!operation) {
      onTransformStepsChange?.(remainingSteps);
      onSelectedIndexChange(index);
      return;
    }

    const option = TRANSFORM_OPTIONS.find((item) => item.operation === operation) ?? TRANSFORM_OPTIONS[0];
    onTransformStepsChange?.([
      ...remainingSteps,
      {
        enabled: true,
        id: `schema-${output}`,
        input: column.sourceName,
        kind: option.kind as TransformStepDraft["kind"],
        label: `${option.label}: ${output}`,
        onError: "Warn",
        operation: option.operation,
        output,
        params: option.params,
      },
    ]);
    onSelectedIndexChange(index);
  };

  const updateTransformParams = (index: number, params: string) => {
    const column = columns[index];
    if (!column) return;
    const output = getOutputName(column);
    onTransformStepsChange?.(transformSteps.map((step) => (
      step.output === output ? { ...step, params, label: `${step.operation}: ${output}` } : step
    )));
    onSelectedIndexChange(index);
  };

  const duplicateTargetColumn = (index: number) => {
    const column = columns[index];
    if (!column) return;
    const insertAt = index + 1;
    const targetName = uniqueTargetName(columns, `${getOutputName(column)}_copy`);
    const nextColumn: SchemaColumnDraft = {
      ...column,
      included: true,
      targetName,
    };
    const nextColumns = [
      ...columns.slice(0, insertAt),
      nextColumn,
      ...columns.slice(insertAt),
    ];
    const nextRows = sampleRows.map((row) => [
      ...row.slice(0, insertAt),
      row[index] ?? "",
      ...row.slice(insertAt),
    ]);
    updateColumns(nextColumns, nextRows);
    onSelectedIndexChange(insertAt);
    const sourceStep = transformByOutput.get(getOutputName(column));
    if (sourceStep) {
      onTransformStepsChange?.([
        ...transformSteps,
        {
          ...sourceStep,
          id: `schema-${targetName}`,
          input: nextColumn.sourceName,
          label: `${sourceStep.operation}: ${targetName}`,
          output: targetName,
        },
      ]);
    }
  };

  const addDerivedTargetColumn = () => {
    const sourceIndex = columns[selectedIndex] ? selectedIndex : 0;
    const sourceColumn = columns[sourceIndex];
    const insertAt = columns.length;
    const targetName = uniqueTargetName(columns, "derived_column");
    const nextColumn: SchemaColumnDraft = {
      confidence: sourceColumn?.confidence,
      included: true,
      nullable: sourceColumn?.nullable ?? true,
      role: "derived",
      sourceName: sourceColumn?.sourceName ?? "derived_column",
      targetName,
      type: sourceColumn?.type ?? "String",
    };
    const nextColumns = [...columns, nextColumn];
    const nextRows = sampleRows.map((row) => [...row, row[sourceIndex] ?? ""]);
    updateColumns(nextColumns, nextRows);
    onSelectedIndexChange(insertAt);
    onTransformStepsChange?.([
      ...transformSteps,
      {
        enabled: true,
        id: `schema-${targetName}`,
        input: nextColumn.sourceName,
        kind: "derive",
        label: `Derived: ${targetName}`,
        onError: "Warn",
        operation: "Cast String",
        output: targetName,
        params: "string",
      },
    ]);
  };

  const moveTarget = (index: number, direction: -1 | 1) => {
    const currentIncludedPosition = includedIndexes.findIndex((item) => item.index === index);
    const nextIncluded = includedIndexes[currentIncludedPosition + direction];
    if (!nextIncluded) return;
    const nextIndex = nextIncluded.index;
    const nextColumns = [...columns];
    [nextColumns[index], nextColumns[nextIndex]] = [nextColumns[nextIndex], nextColumns[index]];
    const nextRows = sampleRows.map((row) => {
      const nextRow = [...row];
      [nextRow[index], nextRow[nextIndex]] = [nextRow[nextIndex], nextRow[index]];
      return nextRow;
    });
    updateColumns(nextColumns, nextRows);
    onSelectedIndexChange(nextIndex);
  };

  return (
    <div className="xflow-transform-editor">
      <div className="xflow-transfer-stage">
        <section className="xflow-transfer-panel">
          <header className="xflow-panel-header source">
            <FileText size={20} />
            <div>
              <h3>Before (Source)</h3>
              <span>{sourceFormat} / {columns.length} fields</span>
            </div>
          </header>
          <div className="xflow-panel-head two">
            <span>FIELD</span>
            <span>SAMPLE</span>
          </div>
          <div className="xflow-column-list">
            {columns.map((column, index) => {
              const selected = selectedBefore.has(index) || selectedIndex === index;
              const sampleValue = sampleRows[0]?.[index] ?? "";
              return (
                <button
                  className={selected ? "xflow-column-row selected" : "xflow-column-row"}
                  key={`before-${column.sourceName}-${index}`}
                  type="button"
                  onClick={() => toggleBefore(index)}
                >
                  <span className={selectedBefore.has(index) ? "xflow-checkbox checked" : "xflow-checkbox"} aria-hidden="true">
                    {selectedBefore.has(index) ? <Check size={12} /> : null}
                  </span>
                  <strong title={column.sourceName}>{displayFieldName(column.sourceName)}</strong>
                  <em title={sampleValue}>{formatSampleValue(sampleValue)}</em>
                </button>
              );
            })}
            {columns.length === 0 && <div className="xflow-empty">No source fields available.</div>}
          </div>
        </section>

        <div className="xflow-transfer-controls" aria-label="schema transfer controls">
          <button type="button" disabled={selectedBeforeCount === 0} onClick={moveSelectedToRight} title="Include selected">
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={columns.length === 0} onClick={moveAllToRight} title="Include all">
            <ChevronsRight size={18} />
          </button>
          <button type="button" disabled={selectedAfterCount === 0} onClick={moveSelectedToLeft} title="Exclude selected">
            <ChevronLeft size={18} />
          </button>
          <button type="button" disabled={includedIndexes.length === 0} onClick={moveAllToLeft} title="Exclude all">
            <ChevronsLeft size={18} />
          </button>
        </div>

        <section className="xflow-transfer-panel">
          <header className="xflow-panel-header target">
            <Table2 size={20} />
            <div>
              <h3>After (Target)</h3>
              <span>{includedIndexes.length} output / {columns.length - includedIndexes.length} excluded</span>
              <div className="xflow-header-actions">
                <button type="button" disabled={!selectedColumn} onClick={() => duplicateTargetColumn(selectedIndex)} title="Duplicate selected target column">
                  <Copy size={14} /> Duplicate
                </button>
                <button type="button" onClick={addDerivedTargetColumn} title="Add derived target column">
                  <Plus size={14} /> Derived
                </button>
              </div>
            </div>
          </header>
          <div className="xflow-panel-head target">
            <span />
            <span>COLUMN</span>
            <span>TYPE</span>
            <span>TRANSFORM</span>
            <span>SAMPLE</span>
            <span />
          </div>
          <div className="xflow-column-list">
            {includedIndexes.map(({ column, index }, orderIndex) => {
              const selected = selectedAfter.has(index) || selectedIndex === index;
              const transformStep = transformByOutput.get(getOutputName(column));
              const sampleValue = sampleRows[0]?.[index] ?? "";
              const preview = previewColumnSample(column, sampleValue, transformStep);
              return (
                <div className={selected ? "xflow-target-row selected" : "xflow-target-row"} key={`after-${column.sourceName}-${index}`} onClick={() => onSelectedIndexChange(index)}>
                  <button
                    aria-label={`Select ${column.sourceName}`}
                    aria-pressed={selectedAfter.has(index)}
                    className={selectedAfter.has(index) ? "xflow-checkbox checked" : "xflow-checkbox"}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleAfter(index);
                    }}
                  >
                    {selectedAfter.has(index) ? <Check size={12} /> : null}
                  </button>
                  <input
                    aria-label={`${column.sourceName} target column`}
                    value={column.targetName}
                    onChange={(event) => updateColumn(index, { targetName: event.currentTarget.value })}
                  />
                  <select value={column.type} onChange={(event) => updateColumn(index, { type: event.currentTarget.value })}>
                    {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                  <div className="xflow-transform-stack">
                    <select
                      aria-label={`${column.sourceName} transform`}
                      className="xflow-transform-select"
                      value={transformStep?.operation ?? ""}
                      onChange={(event) => updateTransform(index, event.currentTarget.value)}
                    >
                      {TRANSFORM_OPTIONS.map((option) => <option key={option.operation || "none"} value={option.operation}>{option.label}</option>)}
                    </select>
                    {transformStep?.operation === "Parse Timestamp" ? (
                      <input
                        aria-label={`${column.sourceName} timestamp format`}
                        className="xflow-transform-param"
                        placeholder="timestamp format"
                        value={transformStep.params}
                        onChange={(event) => updateTransformParams(index, event.currentTarget.value)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : null}
                  </div>
                  <div className="xflow-sample-chip" title={`${preview.before} -> ${preview.after}`}>
                    <span>{formatSampleValue(preview.before)}</span>
                    <strong>{formatSampleValue(preview.after)}</strong>
                  </div>
                  <div className="xflow-row-actions">
                    <button type="button" onClick={(event) => {
                      event.stopPropagation();
                      duplicateTargetColumn(index);
                    }} title="Duplicate column">
                      <Copy size={14} />
                    </button>
                    <button type="button" disabled={orderIndex === 0} onClick={(event) => {
                      event.stopPropagation();
                      moveTarget(index, -1);
                    }} title="Move up">
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" disabled={orderIndex === includedIndexes.length - 1} onClick={(event) => {
                      event.stopPropagation();
                      moveTarget(index, 1);
                    }} title="Move down">
                      <ChevronDown size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
            {includedIndexes.length === 0 && <div className="xflow-empty">Move fields to target to create the output schema.</div>}
          </div>
        </section>
      </div>
      {selectedColumn && selectedPreview ? (
        <aside className="xflow-selected-preview" aria-label="selected transform sample">
          <span>{displaySourcePath(selectedColumn.sourceName)}</span>
          <strong>{selectedColumn.targetName || selectedColumn.sourceName}</strong>
          <em>{formatSampleValue(selectedPreview.before)} {"->"} {formatSampleValue(selectedPreview.after)}</em>
        </aside>
      ) : null}
    </div>
  );
}

function toggleSetValue(current: Set<number>, value: number) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function displayFieldName(value: string) {
  return displaySourcePath(value);
}

function displaySourcePath(value: string) {
  return value
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .join(" / ");
}

function formatSampleValue(value: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "null";
  if (normalized.length > 36) return `${normalized.slice(0, 33)}...`;
  return normalized;
}

function getOutputName(column: SchemaColumnDraft) {
  return column.targetName || column.sourceName;
}

function uniqueTargetName(columns: SchemaColumnDraft[], baseName: string) {
  const names = new Set(columns.map((column) => getOutputName(column)));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName}_${suffix}`)) suffix += 1;
  return `${baseName}_${suffix}`;
}

function previewColumnSample(column: SchemaColumnDraft, rawValue: string, step?: TransformStepDraft) {
  const before = String(rawValue ?? "");
  const transformed = applyPreviewTransform(before, step);
  return {
    after: castPreviewValue(transformed, column.type),
    before,
  };
}

function applyPreviewTransform(value: string, step?: TransformStepDraft) {
  if (!step || step.enabled === false || !step.operation) return value;
  const operation = step.operation.toLowerCase();
  if (operation.includes("number")) return castPreviewValue(value, "Double");
  if (operation.includes("integer")) return castPreviewValue(value, "Integer");
  if (operation.includes("string")) return String(value ?? "");
  if (operation.includes("boolean")) return castPreviewValue(value, "Boolean");
  if (operation.includes("timestamp")) return castPreviewValue(value, "Timestamp");
  return value;
}

function castPreviewValue(value: string, type: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const normalizedType = type.toLowerCase();
  if (["integer", "long"].includes(normalizedType)) {
    const parsed = Number(normalized.replace(/,/g, ""));
    return Number.isFinite(parsed) ? String(Math.trunc(parsed)) : "";
  }
  if (["float", "double"].includes(normalizedType) || normalizedType === "number") {
    const parsed = Number(normalized.replace(/,/g, ""));
    return Number.isFinite(parsed) ? String(parsed) : "";
  }
  if (normalizedType === "boolean") {
    const lower = normalized.toLowerCase();
    if (["true", "1", "yes", "y"].includes(lower)) return "true";
    if (["false", "0", "no", "n"].includes(lower)) return "false";
    return "";
  }
  if (normalizedType === "timestamp" || normalizedType === "date") {
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return "";
    return normalizedType === "date" ? parsed.toISOString().slice(0, 10) : parsed.toISOString();
  }
  return normalized;
}
