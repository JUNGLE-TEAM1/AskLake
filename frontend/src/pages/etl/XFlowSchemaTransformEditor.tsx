import { useMemo, useState } from "react";
import type React from "react";
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
  Trash2,
} from "lucide-react";
import type { SchemaColumnDraft, TransformStepDraft } from "../../types";
import { SourceJsonSampleTree } from "./SourceJsonSampleTree";

const TYPE_OPTIONS = ["String", "Integer", "Long", "Float", "Double", "Boolean", "Timestamp", "Date", "JSON"];

const TRANSFORM_OPTIONS = [
  { label: "원본 값 매핑", operation: "", params: "", kind: "derive" },
  { label: "숫자로 변환", operation: "Cast Number", params: "number", kind: "cast" },
  { label: "정수로 변환", operation: "Cast Integer", params: "integer", kind: "cast" },
  { label: "문자열로 변환", operation: "Cast String", params: "string", kind: "cast" },
  { label: "불리언으로 변환", operation: "Cast Boolean", params: "boolean", kind: "cast" },
  { label: "시간으로 변환", operation: "Parse Timestamp", params: "yyyy-MM-dd HH:mm:ss", kind: "cast" },
  { label: "JSONPath 추출", operation: "Extract JSONPath", params: "$", kind: "jsonPath" },
  { label: "JSON 보존", operation: "Preserve JSON", params: "$", kind: "derive" },
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
  const [expandedSourceIndex, setExpandedSourceIndex] = useState<number | null>(null);
  const [expandedTargetIndex, setExpandedTargetIndex] = useState<number | null>(null);

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
  const outputPreviewColumns = useMemo(
    () => includedIndexes.map(({ column }) => getOutputName(column)),
    [includedIndexes],
  );
  const outputPreviewRows = useMemo(
    () => buildOutputPreviewRows(sampleRows, includedIndexes, transformByOutput),
    [includedIndexes, sampleRows, transformByOutput],
  );

  const updateColumns = (nextColumns: SchemaColumnDraft[], nextRows = sampleRows) => {
    onColumnsChange(nextColumns, nextRows);
  };

  const toggleBefore = (index: number) => {
    setSelectedBefore((current) => toggleSetValue(current, index));
    setExpandedSourceIndex((current) => (current === index ? null : index));
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
    setExpandedTargetIndex(null);
    onTransformStepsChange?.(transformSteps.filter((step) => !removedOutputs.has(step.output)));
    const nextSelected = nextColumns.findIndex((column) => column.included !== false);
    onSelectedIndexChange(Math.max(0, nextSelected));
  };

  const excludeTargetColumn = (index: number) => {
    const column = columns[index];
    if (!column) return;
    const output = getOutputName(column);
    updateColumns(columns.map((currentColumn, columnIndex) => (
      columnIndex === index ? { ...currentColumn, included: false } : currentColumn
    )));
    setSelectedAfter((current) => {
      const next = new Set(current);
      next.delete(index);
      return next;
    });
    setExpandedTargetIndex((current) => (current === index ? null : current));
    onTransformStepsChange?.(transformSteps.filter((step) => step.output !== output));
  };

  const moveAllToLeft = () => {
    updateColumns(columns.map((column) => ({ ...column, included: false })));
    setSelectedAfter(new Set());
    setExpandedTargetIndex(null);
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
      role: `duplicate:${getOutputName(column)}`,
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

  const toggleTargetDetail = (index: number) => {
    setExpandedTargetIndex((current) => (current === index ? null : index));
    onSelectedIndexChange(index);
  };

  const toggleTargetDetailFromEvent = (event: React.MouseEvent<HTMLElement>, index: number) => {
    event.stopPropagation();
    const record = event.currentTarget.closest(".xflow-target-record");
    toggleTargetDetail(index);
    window.requestAnimationFrame(() => {
      record?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
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
              const expanded = expandedSourceIndex === index;
              const sampleValue = sampleRows[0]?.[index] ?? "";
              const sourceDepth = sourcePathDepth(column.sourceName);
              return (
                <div className={expanded ? "xflow-source-record expanded" : "xflow-source-record"} key={`before-${column.sourceName}-${index}`}>
                  <button
                    className={selected ? "xflow-column-row selected" : "xflow-column-row"}
                    type="button"
                    style={{ "--xflow-source-depth": sourceDepth } as React.CSSProperties}
                    onClick={() => toggleBefore(index)}
                  >
                    <span className={selectedBefore.has(index) ? "xflow-checkbox checked" : "xflow-checkbox"} aria-hidden="true">
                      {selectedBefore.has(index) ? <Check size={12} /> : null}
                    </span>
                    <span className="xflow-source-name" title={column.sourceName}>
                      {sourceDepth > 0 ? <i aria-hidden="true" /> : null}
                      <span className="xflow-source-copy">
                        {sourceParentPath(column.sourceName) ? <small>{sourceParentPath(column.sourceName)}</small> : null}
                        <strong>{sourceLeafName(column.sourceName)}</strong>
                      </span>
                    </span>
                    <ChevronDown className="xflow-source-chevron" size={14} />
                    <em title={sampleValue}>{formatSampleValue(sampleValue)}</em>
                  </button>
                  {expanded ? (
                    <div className="xflow-source-detail">
                      <span>SAMPLE</span>
                      {renderSampleDetail(sampleValue, sourceLeafName(column.sourceName))}
                      <small title={column.sourceName}>{displaySourcePath(column.sourceName)}</small>
                    </div>
                  ) : null}
                </div>
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
            <span />
          </div>
          <div className="xflow-column-list">
            {includedIndexes.map(({ column, index }, orderIndex) => {
              const selected = selectedAfter.has(index) || selectedIndex === index;
              const expanded = expandedTargetIndex === index;
              const transformStep = transformByOutput.get(getOutputName(column));
              const sampleValue = sampleRows[0]?.[index] ?? "";
              const preview = previewColumnSample(column, sampleValue, transformStep);
              const sampleComparisonClass = preview.changed ? "xflow-before-after-samples" : "xflow-before-after-samples same";
              return (
                <div className={expanded ? "xflow-target-record expanded" : "xflow-target-record"} key={`after-${column.sourceName}-${index}`}>
                  <div className={selected ? "xflow-target-row selected" : "xflow-target-row"} onClick={() => onSelectedIndexChange(index)}>
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
                      onClick={(event) => event.stopPropagation()}
                    />
                    <select value={column.type} onChange={(event) => updateColumn(index, { type: event.currentTarget.value })} onClick={(event) => event.stopPropagation()}>
                      {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <button
                      className={transformStep?.operation ? "xflow-transform-summary active" : "xflow-transform-summary muted"}
                      type="button"
                      aria-expanded={expanded}
                      onClick={(event) => toggleTargetDetailFromEvent(event, index)}
                    >
                      {transformStep?.operation ? transformSummaryLabel(transformStep) : defaultTransformLabel(column)}
                    </button>
                    <div className="xflow-row-actions">
                      <button type="button" onClick={(event) => toggleTargetDetailFromEvent(event, index)} title={expanded ? "Hide details" : "Show details"}>
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button type="button" onClick={(event) => {
                        event.stopPropagation();
                        excludeTargetColumn(index);
                      }} title="Exclude column">
                        <Trash2 size={14} />
                      </button>
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
                  {expanded ? (
                    <div className="xflow-target-detail" onClick={(event) => event.stopPropagation()}>
                      <label>
                        <span>MAPPING</span>
                        {sourceParentPath(column.sourceName) ? (
                          <small className="xflow-mapping-parent" title={displaySourcePath(column.sourceName)}>
                            child of {sourceParentPath(column.sourceName)}
                          </small>
                        ) : null}
                        <strong title={`${column.sourceName} -> ${getOutputName(column)}`}>{displaySourcePath(column.sourceName)} {"->"} {getOutputName(column)}</strong>
                      </label>
                      <label>
                        <span>TRANSFORM</span>
                        <select
                          aria-label={`${column.sourceName} transform`}
                          className="xflow-transform-select"
                          value={transformStep?.operation ?? ""}
                          onChange={(event) => updateTransform(index, event.currentTarget.value)}
                        >
                          {TRANSFORM_OPTIONS.map((option) => <option key={option.operation || "none"} value={option.operation}>{option.label}</option>)}
                        </select>
                        <small className="xflow-transform-note">{transformDetailText(column, transformStep)}</small>
                      </label>
                      {transformStep?.operation === "Parse Timestamp" || transformStep?.operation === "Extract JSONPath" ? (
                        <label>
                          <span>{transformStep.operation === "Extract JSONPath" ? "JSONPATH" : "FORMAT"}</span>
                          <input
                            aria-label={`${column.sourceName} transform parameter`}
                            className="xflow-transform-param"
                            placeholder={transformStep.operation === "Extract JSONPath" ? "$.field" : "timestamp format"}
                            value={transformStep.params}
                            onChange={(event) => updateTransformParams(index, event.currentTarget.value)}
                          />
                        </label>
                      ) : null}
                      <div className="xflow-target-sample-detail">
                        <span>BEFORE / AFTER SAMPLE</span>
                        <small className="xflow-sample-reason">{samplePreviewReason(column, transformStep, preview)}</small>
                        <div className={sampleComparisonClass} title={`${preview.before} -> ${preview.after}`}>
                          <section className="xflow-sample-panel">
                            <header>Before</header>
                            {renderSampleDetail(preview.before, sourceLeafName(column.sourceName))}
                          </section>
                          <section className="xflow-sample-panel output">
                            <header>After</header>
                            {preview.changed ? (
                              renderSampleDetail(preview.after, getOutputName(column))
                            ) : (
                              <div className="xflow-same-output">
                                <strong>값 동일</strong>
                                <span>{sameValueReason(column, transformStep)}</span>
                              </div>
                            )}
                          </section>
                        </div>
                      </div>
                      {duplicateOrigin(column) ? (
                        <div className="xflow-duplicate-origin">
                          <span>DUPLICATE OF</span>
                          <strong>{duplicateOrigin(column)}</strong>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {includedIndexes.length === 0 && <div className="xflow-empty">Move fields to target to create the output schema.</div>}
          </div>
        </section>
      </div>
      <section className="xflow-output-preview" aria-label="final output preview">
        <header>
          <div>
            <strong>Final Output Preview</strong>
            <span>현재 target schema와 transform을 샘플 {outputPreviewRows.length}행에 적용한 결과입니다.</span>
          </div>
          <em>{outputPreviewColumns.length} columns</em>
        </header>
        {outputPreviewRows.length > 0 ? (
          <SourceJsonSampleTree columns={outputPreviewColumns} format={sourceFormat} rows={outputPreviewRows} />
        ) : (
          <p className="source-empty-note">target에 포함된 컬럼과 샘플 row가 있으면 최종 output 구조가 표시됩니다.</p>
        )}
      </section>
      {expandedTargetIndex !== null && selectedColumn && selectedPreview ? (
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

function sourceLeafName(value: string) {
  const normalized = displaySourcePath(value);
  return normalized.split(" / ").at(-1) ?? normalized;
}

function sourceParentPath(value: string) {
  const parts = displaySourcePath(value).split(" / ");
  return parts.length > 1 ? parts.slice(0, -1).join(" / ") : "";
}

function sourcePathDepth(value: string) {
  return Math.max(0, displaySourcePath(value).split(" / ").length - 1);
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

function formatDetailSampleValue(value: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "null";
  if (normalized.length > 180) return `${normalized.slice(0, 177)}...`;
  return normalized;
}

function renderSampleDetail(value: string, rootLabel = "root") {
  const parsed = parseJsonSample(value);
  if (parsed !== undefined) {
    return (
      <div className="xflow-json-sample-tree">
        <SourceJsonSampleTree columns={[rootLabel]} format="JSON" rows={[[String(value ?? "")]]} />
      </div>
    );
  }
  return <code className="xflow-sample-code" title={value}>{formatDetailSampleValue(value)}</code>;
}

function parseJsonSample(value: string) {
  const normalized = String(value ?? "").trim();
  if (!/^[\[{]/.test(normalized)) return undefined;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}

function getOutputName(column: SchemaColumnDraft) {
  return column.targetName || column.sourceName;
}

function transformSummaryLabel(step?: TransformStepDraft) {
  if (!step || step.enabled === false || !step.operation) return "원본 값 매핑";
  return TRANSFORM_OPTIONS.find((option) => option.operation === step.operation)?.label ?? step.operation;
}

function defaultTransformLabel(column: SchemaColumnDraft) {
  const output = getOutputName(column);
  const renamed = output !== column.sourceName;
  const nested = /[.[\]]/.test(column.sourceName);
  const normalizedType = column.type.toLowerCase();
  if (normalizedType === "json") return nested ? "JSON 경로 컬럼화" : "JSON 보존";
  if (nested) return "중첩 경로 컬럼화";
  if (renamed) return "이름 변경";
  return "원본 값 매핑";
}

function transformDetailText(column: SchemaColumnDraft, step?: TransformStepDraft) {
  if (step?.enabled !== false && step?.operation) {
    if (step.operation === "Extract JSONPath") {
      return `${step.params || "$"} 경로를 추출할 때만 값이 달라집니다.`;
    }
    if (step.operation === "Preserve JSON") {
      return "배열/객체 JSON을 펼치지 않고 target 컬럼에 그대로 보존합니다.";
    }
    return `${transformSummaryLabel(step)}을 적용해 target 값을 생성합니다.`;
  }
  const output = getOutputName(column);
  if (output !== column.sourceName) return "컬럼 이름만 바꾸고 값은 원본 그대로 매핑합니다.";
  if (/[.[\]]/.test(column.sourceName)) return "중첩 source 경로를 flat target 컬럼으로 만들고 값은 그대로 둡니다.";
  if (column.type.toLowerCase() === "json") return "JSON 값을 target JSON 컬럼에 보존합니다. 값 변환은 선택 시에만 적용됩니다.";
  return "값 변환 없이 source 값을 target schemaColumns에 매핑합니다.";
}

function samplePreviewReason(column: SchemaColumnDraft, step: TransformStepDraft | undefined, preview: { before: string; after: string; changed: boolean }) {
  if (preview.changed) return `${transformSummaryLabel(step)} 결과로 샘플 값이 변경됩니다.`;
  if (step?.enabled !== false && step?.operation) return `${transformSummaryLabel(step)}을 적용했지만 이 샘플 값은 동일합니다.`;
  if (column.type.toLowerCase() === "json") return "현재는 JSON 값을 보존하는 스키마 매핑입니다. JSONPath 추출을 선택하면 After 값이 달라집니다.";
  return "현재는 스키마 매핑 단계라 값은 유지됩니다. 값 변환은 Transform 선택 시에만 적용됩니다.";
}

function sameValueReason(column: SchemaColumnDraft, step?: TransformStepDraft) {
  if (step?.enabled !== false && step?.operation) return "이 샘플에서는 변환 결과가 원본과 같습니다.";
  if (/[.[\]]/.test(column.sourceName)) return "경로만 target 컬럼으로 정형화했습니다.";
  if (column.type.toLowerCase() === "json") return "JSON 보존 매핑입니다.";
  return "원본 값을 그대로 사용합니다.";
}

function uniqueTargetName(columns: SchemaColumnDraft[], baseName: string) {
  const names = new Set(columns.map((column) => getOutputName(column)));
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName}_${suffix}`)) suffix += 1;
  return `${baseName}_${suffix}`;
}

function duplicateOrigin(column: SchemaColumnDraft) {
  if (column.role?.startsWith("duplicate:")) return column.role.slice("duplicate:".length);
  const output = getOutputName(column);
  const match = output.match(/^(.+?)(?:[._]copy)(?:_\d+)?$/i);
  return match?.[1] ?? "";
}

function buildOutputPreviewRows(
  sampleRows: string[][],
  includedIndexes: Array<{ column: SchemaColumnDraft; index: number }>,
  transformByOutput: Map<string, TransformStepDraft>,
) {
  if (includedIndexes.length === 0) return [];
  return sampleRows.slice(0, 3).map((row) => (
    includedIndexes.map(({ column, index }) => {
      const step = transformByOutput.get(getOutputName(column));
      return previewOutputValue(column, row[index] ?? "", step);
    })
  ));
}

function previewOutputValue(column: SchemaColumnDraft, rawValue: string, step?: TransformStepDraft) {
  const before = String(rawValue ?? "");
  const transformed = applyPreviewTransform(before, step);
  const hasValueTransform = Boolean(step?.enabled !== false && step?.operation);
  return hasValueTransform ? castPreviewValue(transformed, column.type) : transformed;
}

function previewColumnSample(column: SchemaColumnDraft, rawValue: string, step?: TransformStepDraft) {
  const before = String(rawValue ?? "");
  const after = previewOutputValue(column, before, step);
  return {
    after,
    before,
    changed: before !== after,
  };
}

function applyPreviewTransform(value: string, step?: TransformStepDraft) {
  if (!step || step.enabled === false || !step.operation) return value;
  const operation = step.operation.toLowerCase();
  if (operation.includes("jsonpath")) return extractJsonPathPreview(value, step.params);
  if (operation.includes("number")) return castPreviewValue(value, "Double");
  if (operation.includes("integer")) return castPreviewValue(value, "Integer");
  if (operation.includes("string")) return String(value ?? "");
  if (operation.includes("boolean")) return castPreviewValue(value, "Boolean");
  if (operation.includes("timestamp")) return castPreviewValue(value, "Timestamp");
  return value;
}

function extractJsonPathPreview(value: string, path: string) {
  const parsed = parseJsonSample(value);
  if (parsed === undefined) return "";
  const normalizedPath = path.trim() || "$";
  if (normalizedPath === "$") return JSON.stringify(parsed);
  const segments = normalizedPath
    .replace(/^\$\./, "")
    .replace(/^\$/, "")
    .split(".")
    .filter(Boolean);
  let current: unknown = parsed;
  for (const segment of segments) {
    const arrayMatch = segment.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, indexText] = arrayMatch;
      current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
      current = Array.isArray(current) ? current[Number(indexText)] : undefined;
      continue;
    }
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (current === undefined) return "";
  return typeof current === "string" ? current : JSON.stringify(current);
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
