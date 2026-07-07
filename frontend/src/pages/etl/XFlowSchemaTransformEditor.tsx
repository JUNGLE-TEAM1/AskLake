import { useMemo, useState } from "react";
import type React from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
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
  { label: "JSON 구조 유지", operation: "Preserve JSON", params: "$", kind: "derive" },
] as const;

const TRANSFORM_MODULE_SLOTS = [
  { key: "flatten_object", label: "flatten_object", desc: "nested object를 flat columns로 펼침" },
  { key: "jsonpath_extract", label: "jsonpath_extract", desc: "JSONPath로 scalar/array 일부 추출" },
  { key: "array_explode", label: "array_explode", desc: "array를 row explode 또는 first item으로 변환" },
  { key: "cast_schema", label: "cast_schema", desc: "target type 기준 cast/validation" },
] as const;

type TransformAuthoringMode = "sql" | "python" | "module";
type OutputPreviewRow = Record<string, string>;
type TransformModuleKey = typeof TRANSFORM_MODULE_SLOTS[number]["key"];
type TransformProjection = {
  input: string;
  operation?: string;
  output: string;
  params?: string;
  type?: string;
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
  const [showCodeWorkbench, setShowCodeWorkbench] = useState(false);
  const [transformMode, setTransformMode] = useState<TransformAuthoringMode>("sql");
  const [showOutputPreview, setShowOutputPreview] = useState(false);
  const [authoringStatus, setAuthoringStatus] = useState("스키마 매핑을 먼저 조정한 뒤 필요한 경우 고급 변환을 적용합니다.");
  const [transformCodeByMode, setTransformCodeByMode] = useState<Record<TransformAuthoringMode, string>>({
    module: "",
    python: "",
    sql: "",
  });

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
  const generatedTransformCode = useMemo(
    () => buildTransformAuthoringTemplate(transformMode, includedIndexes),
    [includedIndexes, transformMode],
  );
  const activeTransformCode = transformCodeByMode[transformMode] || generatedTransformCode;
  const outputPreviewColumns = useMemo(
    () => showOutputPreview ? includedIndexes.map(({ column }) => getOutputName(column)) : [],
    [includedIndexes, showOutputPreview],
  );
  const outputPreviewRows = useMemo(
    () => showOutputPreview ? buildOutputPreviewRows(sampleRows, includedIndexes, transformByOutput) : [],
    [includedIndexes, sampleRows, showOutputPreview, transformByOutput],
  );
  const outputPreviewTableRows = useMemo(
    () => buildOutputPreviewTableRows(outputPreviewColumns, outputPreviewRows),
    [outputPreviewColumns, outputPreviewRows],
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

  const updateTransformCode = (value: string) => {
    setTransformCodeByMode((current) => ({ ...current, [transformMode]: value }));
  };

  const resetTransformCode = () => {
    setTransformCodeByMode((current) => ({ ...current, [transformMode]: "" }));
    setAuthoringStatus("현재 target schema 기준 템플릿을 다시 생성했습니다.");
  };

  const applyCodeTransform = () => {
    const projections = parseTransformProjections(transformMode, activeTransformCode, columns);
    if (projections.length === 0) {
      setAuthoringStatus("적용 가능한 SELECT/dict/module mapping을 찾지 못했습니다.");
      return;
    }
    const next = buildProjectedSchema(columns, sampleRows, projections);
    if (next.columns.length === 0) {
      setAuthoringStatus("현재 sample에서 적용 가능한 output column이 없습니다.");
      return;
    }
    updateColumns(next.columns, next.rows);
    onTransformStepsChange?.(next.steps);
    setSelectedBefore(new Set());
    setSelectedAfter(new Set());
    setExpandedTargetIndex(null);
    onSelectedIndexChange(0);
    setShowOutputPreview(true);
    setAuthoringStatus(`${next.columns.length}개 output column에 코드 변환을 적용했습니다.`);
  };

  const applyModuleSlot = (moduleKey: TransformModuleKey) => {
    if (moduleKey === "cast_schema") {
      const castSteps = includedIndexes
        .filter(({ column }) => column.type.toLowerCase() !== "json")
        .map(({ column }) => buildCastTransformStep(column))
        .filter(Boolean) as TransformStepDraft[];
      const replacedOutputs = new Set(castSteps.map((step) => step.output));
      onTransformStepsChange?.([
        ...transformSteps.filter((step) => !replacedOutputs.has(step.output)),
        ...castSteps,
      ]);
      setShowOutputPreview(true);
      setAuthoringStatus(`target type 기준 cast step ${castSteps.length}개를 적용했습니다.`);
      return;
    }

    const sourceIndex = columns[selectedIndex] ? selectedIndex : includedIndexes[0]?.index;
    const sourceColumn = typeof sourceIndex === "number" ? columns[sourceIndex] : undefined;
    if (!sourceColumn) {
      setAuthoringStatus("모듈을 적용할 source/target row를 먼저 선택하세요.");
      return;
    }
    const projections = buildModuleProjections(moduleKey, sourceColumn, sampleRows[0]?.[sourceIndex] ?? "");
    if (projections.length === 0) {
      setAuthoringStatus(`${sourceColumn.sourceName} 샘플에서 ${moduleKey} 적용 대상을 찾지 못했습니다.`);
      return;
    }
    const next = appendProjectedColumns(columns, sampleRows, transformSteps, projections);
    updateColumns(next.columns, next.rows);
    onTransformStepsChange?.(next.steps);
    onSelectedIndexChange(Math.max(0, next.columns.length - projections.length));
    setShowOutputPreview(true);
    setAuthoringStatus(`${moduleKey} 모듈이 ${projections.length}개 output column을 추가했습니다.`);
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
                    <em title={sampleValue}>{formatSampleValue(sampleValue)}</em>
                    <ChevronDown className="xflow-source-chevron" size={14} />
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
                    </div>
                  </div>
                  {expanded ? (
                    <div className="xflow-target-detail" onClick={(event) => event.stopPropagation()}>
                      <label>
                        <span>매핑</span>
                        {sourceParentPath(column.sourceName) ? (
                          <small className="xflow-mapping-parent" title={displaySourcePath(column.sourceName)}>
                            {sourceParentPath(column.sourceName)}
                          </small>
                        ) : null}
                        <strong title={`${column.sourceName} -> ${getOutputName(column)}`}>{displaySourcePath(column.sourceName)} {"->"} {getOutputName(column)}</strong>
                      </label>
                      <label>
                        <span>변환</span>
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
                          <span>{transformStep.operation === "Extract JSONPath" ? "JSONPath" : "형식"}</span>
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
                        <span>샘플 비교</span>
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
                          <span>복제 원본</span>
                          <strong>{duplicateOrigin(column)}</strong>
                        </div>
                      ) : null}
                      <div className="xflow-detail-actions">
                        <button type="button" onClick={() => duplicateTargetColumn(index)}>
                          <Copy size={14} /> 복제
                        </button>
                        <button type="button" disabled={orderIndex === 0} onClick={() => moveTarget(index, -1)}>
                          <ChevronUp size={14} /> 위로
                        </button>
                        <button type="button" disabled={orderIndex === includedIndexes.length - 1} onClick={() => moveTarget(index, 1)}>
                          <ChevronDown size={14} /> 아래로
                        </button>
                        <button className="danger" type="button" onClick={() => excludeTargetColumn(index)}>
                          <Trash2 size={14} /> 제외
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {includedIndexes.length === 0 && <div className="xflow-empty">Move fields to target to create the output schema.</div>}
          </div>
        </section>
      </div>
      <section className="xflow-flow-toolbar" aria-label="schema transform actions">
        <div>
          <strong>{includedIndexes.length} output</strong>
          <span>{transformSteps.filter((step) => step.enabled !== false).length} transform</span>
        </div>
        <div>
          <button className="secondary-button compact" type="button" onClick={() => setShowCodeWorkbench((current) => !current)}>
            {showCodeWorkbench ? "고급 닫기" : "고급"}
          </button>
          <button className="primary-button compact" type="button" onClick={() => setShowOutputPreview((current) => !current)}>
            {showOutputPreview ? "샘플 닫기" : "최종 샘플"}
          </button>
        </div>
      </section>
      {showCodeWorkbench ? (
        <section className="xflow-code-workbench" aria-label="structured transform authoring">
          <header>
            <div>
              <strong>정형 변환 작업대</strong>
              <span>SQL, Python, 모듈 훅을 target schema에 적용합니다.</span>
            </div>
            <div className="xflow-code-modes" role="tablist" aria-label="transform authoring mode">
              {(["sql", "python", "module"] as TransformAuthoringMode[]).map((mode) => (
                <button
                  aria-pressed={transformMode === mode}
                  className={transformMode === mode ? "active" : ""}
                  key={mode}
                  type="button"
                  onClick={() => setTransformMode(mode)}
                >
                  {mode === "sql" ? "SQL" : mode === "python" ? "Python" : "Modules"}
                </button>
              ))}
            </div>
          </header>
          <div className="xflow-code-body">
            <label className="xflow-code-editor">
              <span>{transformMode === "sql" ? "SQL transform" : transformMode === "python" ? "Python transform" : "Module pipeline"}</span>
              <textarea
                spellCheck={false}
                value={activeTransformCode}
                onChange={(event) => updateTransformCode(event.currentTarget.value)}
              />
            </label>
            <aside className="xflow-module-slots">
              <span>Plug-in slots</span>
              {TRANSFORM_MODULE_SLOTS.map((slot) => (
                <button key={slot.key} type="button" title={slot.desc} onClick={() => applyModuleSlot(slot.key)}>
                  <strong>{slot.label}</strong>
                  <em>{slot.desc}</em>
                </button>
              ))}
            </aside>
          </div>
          <footer>
            <span>{authoringStatus}</span>
            <div>
              <button className="secondary-button" type="button" onClick={() => setShowCodeWorkbench(false)}>닫기</button>
              <button className="secondary-button" type="button" onClick={resetTransformCode}>템플릿 재생성</button>
              <button className="primary-button" type="button" onClick={applyCodeTransform}>변환 적용</button>
            </div>
          </footer>
        </section>
      ) : null}
      {showOutputPreview ? (
      <section className="xflow-output-preview" aria-label="final output preview">
        <header>
          <div>
            <strong>최종 Output 미리보기</strong>
            <span>현재 target schema와 transform을 샘플 {outputPreviewRows.length}행에 적용한 결과입니다.</span>
          </div>
          <em>{outputPreviewColumns.length} columns</em>
        </header>
        {outputPreviewTableRows.length > 0 ? (
          <OutputPreviewTable columns={outputPreviewColumns} rows={outputPreviewTableRows} />
        ) : (
          <p className="source-empty-note">target에 포함된 컬럼과 샘플 row가 있으면 최종 output 구조가 표시됩니다.</p>
        )}
      </section>
      ) : null}
    </div>
  );
}

function OutputPreviewTable({ columns, rows }: { columns: string[]; rows: OutputPreviewRow[] }) {
  const columnDefs = useMemo<ColumnDef<OutputPreviewRow>[]>(() => (
    columns.map((column, index) => ({
      accessorKey: outputPreviewColumnKey(column, index),
      cell: (info) => <code>{formatOutputTableCell(info.getValue())}</code>,
      header: column,
      id: outputPreviewColumnKey(column, index),
    }))
  ), [columns]);

  const table = useReactTable({
    columns: columnDefs,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="xflow-output-table-shell">
      <table>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
  if (normalizedType === "json") return nested ? "JSON 경로 컬럼화" : "JSON 구조 유지";
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
      return "배열/객체 JSON을 펼치지 않고 target 컬럼에 구조 그대로 유지합니다.";
    }
    return `${transformSummaryLabel(step)}을 적용해 target 값을 생성합니다.`;
  }
  const output = getOutputName(column);
  if (output !== column.sourceName) return "컬럼 이름만 바꾸고 값은 원본 그대로 매핑합니다.";
  if (/[.[\]]/.test(column.sourceName)) return "중첩 source 경로를 flat target 컬럼으로 만들고 값은 그대로 둡니다.";
  if (column.type.toLowerCase() === "json") return "JSON 값을 target JSON 컬럼에 구조 그대로 유지합니다. 값 변환은 선택 시에만 적용됩니다.";
  return "값 변환 없이 source 값을 target schemaColumns에 매핑합니다.";
}

function samplePreviewReason(column: SchemaColumnDraft, step: TransformStepDraft | undefined, preview: { before: string; after: string; changed: boolean }) {
  if (preview.changed) return `${transformSummaryLabel(step)} 결과로 샘플 값이 변경됩니다.`;
  if (step?.enabled !== false && step?.operation) return `${transformSummaryLabel(step)}을 적용했지만 이 샘플 값은 동일합니다.`;
  if (column.type.toLowerCase() === "json") return "현재는 JSON 구조 유지 매핑입니다. JSONPath 추출을 선택하면 After 값이 달라집니다.";
  return "현재는 스키마 매핑 단계라 값은 유지됩니다. 값 변환은 Transform 선택 시에만 적용됩니다.";
}

function sameValueReason(column: SchemaColumnDraft, step?: TransformStepDraft) {
  if (step?.enabled !== false && step?.operation) return "이 샘플에서는 변환 결과가 원본과 같습니다.";
  if (/[.[\]]/.test(column.sourceName)) return "경로만 target 컬럼으로 정형화했습니다.";
  if (column.type.toLowerCase() === "json") return "JSON 구조 유지 매핑입니다.";
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

function buildTransformAuthoringTemplate(mode: TransformAuthoringMode, includedIndexes: Array<{ column: SchemaColumnDraft; index: number }>) {
  const columns = includedIndexes.slice(0, 16).map(({ column }) => column);
  if (mode === "python") {
    const lines = columns.map((column) =>
      `        ${JSON.stringify(getOutputName(column))}: modules.cast(row.get(${JSON.stringify(column.sourceName)}), ${JSON.stringify(column.type)}),`,
    );
    return [
      "def transform(row, modules):",
      "    return {",
      ...lines,
      "    }",
      "",
      "# modules: jsonpath_extract, flatten_object, array_explode, cast_schema",
    ].join("\n");
  }
  if (mode === "module") {
    return [
      "pipeline:",
      "  - module: flatten_object",
      "    input: source",
      "    prefix_nested_keys: true",
      "  - module: jsonpath_extract",
      "    mappings:",
      ...columns.filter((column) => column.type.toLowerCase() === "json").slice(0, 4).map((column) => `      ${getOutputName(column)}: ${column.sourceName} -> $`),
      "  - module: cast_schema",
      "    schema: target",
    ].join("\n");
  }
  const selectLines = columns.map((column) => `  ${sqlSourceExpression(column)} AS ${sqlIdentifier(getOutputName(column))}`);
  return [
    "-- source_sample은 현재 제한 샘플 row입니다.",
    "-- JSON/array는 JSONPath 추출 또는 flatten module로 정형화합니다.",
    "SELECT",
    selectLines.join(",\n"),
    "FROM source_sample;",
  ].join("\n");
}

function parseTransformProjections(mode: TransformAuthoringMode, code: string, columns: SchemaColumnDraft[]): TransformProjection[] {
  if (mode === "module") return parseModuleProjections(code, columns);
  if (mode === "python") return parsePythonDictProjections(code, columns);
  return parseSqlSelectProjections(code, columns);
}

function parseSqlSelectProjections(code: string, columns: SchemaColumnDraft[]): TransformProjection[] {
  const selectMatch = code.match(/select\s+([\s\S]*?)\s+from\s+/i);
  if (!selectMatch) return [];
  return selectMatch[1]
    .split(/,\s*\n|,\s*(?=(?:(?:[^"]*"){2})*[^"]*$)/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((line) => {
      const aliasMatch = line.match(/(.+?)\s+as\s+("?[\w.[\]\s-]+"?)$/i);
      const inputExpression = (aliasMatch?.[1] ?? line).trim();
      const output = unquoteSqlIdentifier(aliasMatch?.[2] ?? inputExpression);
      const matchedColumn = findProjectionColumn(columns, inputExpression, output);
      return {
        input: matchedColumn?.sourceName ?? unquoteSqlIdentifier(inputExpression),
        operation: inferProjectionOperation(inputExpression, matchedColumn),
        output,
        params: inputExpression.includes("JSON_VALUE") ? jsonPathFromSqlExpression(inputExpression) : undefined,
        type: matchedColumn?.type,
      };
    });
}

function parsePythonDictProjections(code: string, columns: SchemaColumnDraft[]): TransformProjection[] {
  const projections: TransformProjection[] = [];
  const entryPattern = /["']([^"']+)["']\s*:\s*([\s\S]*?)(?:,\s*\n|\n\s*})/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(code)) !== null) {
    const output = match[1];
    const expression = match[2].trim();
    const inputMatch = expression.match(/row\.get\(["']([^"']+)["']\)/);
    const typeMatch = expression.match(/,\s*["']([^"']+)["']\s*\)/);
    const matchedColumn = findProjectionColumn(columns, inputMatch?.[1] ?? output, output);
    projections.push({
      input: inputMatch?.[1] ?? matchedColumn?.sourceName ?? output,
      operation: typeMatch ? "Cast String" : undefined,
      output,
      params: typeMatch?.[1],
      type: typeMatch?.[1] ?? matchedColumn?.type,
    });
  }
  return projections;
}

function parseModuleProjections(code: string, columns: SchemaColumnDraft[]): TransformProjection[] {
  if (/cast_schema/i.test(code)) {
    return columns
      .filter((column) => column.included !== false)
      .map((column) => ({
        input: column.sourceName,
        operation: castOperationForType(column.type),
        output: getOutputName(column),
        params: column.type,
        type: column.type,
      }));
  }
  return [];
}

function buildProjectedSchema(columns: SchemaColumnDraft[], sampleRows: string[][], projections: TransformProjection[]) {
  const sourceIndexes = new Map(columns.map((column, index) => [column.sourceName, index]));
  const nextColumns = projections.map((projection): SchemaColumnDraft => {
    const sourceColumn = columns[sourceIndexes.get(projection.input) ?? -1];
    return {
      confidence: sourceColumn?.confidence,
      included: true,
      nullable: sourceColumn?.nullable ?? true,
      role: projection.operation ? "transformed" : sourceColumn?.role,
      sourceName: projection.input,
      targetName: projection.output,
      type: projection.type ?? sourceColumn?.type ?? "String",
    };
  });
  const nextRows = sampleRows.map((row) => (
    projections.map((projection) => {
      const sourceIndex = sourceIndexes.get(projection.input);
      const rawValue = typeof sourceIndex === "number" ? row[sourceIndex] ?? "" : "";
      return previewOutputValue({ sourceName: projection.input, targetName: projection.output, type: projection.type ?? "String", included: true, nullable: true }, rawValue, projectionToStep(projection));
    })
  ));
  const steps = projections.map(projectionToStep).filter(Boolean) as TransformStepDraft[];
  return { columns: nextColumns, rows: nextRows, steps };
}

function appendProjectedColumns(
  columns: SchemaColumnDraft[],
  sampleRows: string[][],
  transformSteps: TransformStepDraft[],
  projections: TransformProjection[],
) {
  const sourceIndexes = new Map(columns.map((column, index) => [column.sourceName, index]));
  const appendedColumns = projections.map((projection): SchemaColumnDraft => {
    const sourceColumn = columns[sourceIndexes.get(projection.input) ?? -1];
    return {
      confidence: sourceColumn?.confidence,
      included: true,
      nullable: sourceColumn?.nullable ?? true,
      role: "derived",
      sourceName: projection.input,
      targetName: uniqueTargetName(columns, projection.output),
      type: projection.type ?? sourceColumn?.type ?? "String",
    };
  });
  const nextRows = sampleRows.map((row) => [
    ...row,
    ...projections.map((projection) => {
      const sourceIndex = sourceIndexes.get(projection.input);
      const rawValue = typeof sourceIndex === "number" ? row[sourceIndex] ?? "" : "";
      return previewOutputValue({ sourceName: projection.input, targetName: projection.output, type: projection.type ?? "String", included: true, nullable: true }, rawValue, projectionToStep(projection));
    }),
  ]);
  const appendedSteps = appendedColumns.map((column, index) => projectionToStep({ ...projections[index], output: getOutputName(column) })).filter(Boolean) as TransformStepDraft[];
  return { columns: [...columns, ...appendedColumns], rows: nextRows, steps: [...transformSteps, ...appendedSteps] };
}

function buildCastTransformStep(column: SchemaColumnDraft): TransformStepDraft | undefined {
  const operation = castOperationForType(column.type);
  if (!operation) return undefined;
  const output = getOutputName(column);
  return {
    enabled: true,
    id: `schema-${output}`,
    input: column.sourceName,
    kind: "cast",
    label: `${operation}: ${output}`,
    onError: "Warn",
    operation,
    output,
    params: column.type,
  };
}

function buildModuleProjections(moduleKey: TransformModuleKey, sourceColumn: SchemaColumnDraft, sampleValue: string): TransformProjection[] {
  if (moduleKey === "jsonpath_extract") {
    return [{
      input: sourceColumn.sourceName,
      operation: "Extract JSONPath",
      output: uniqueProjectionOutput(sourceColumn, "json_value"),
      params: "$",
      type: "String",
    }];
  }
  if (moduleKey === "array_explode") {
    return [{
      input: sourceColumn.sourceName,
      operation: "Extract JSONPath",
      output: uniqueProjectionOutput(sourceColumn, "first_item"),
      params: "$[0]",
      type: "String",
    }];
  }
  if (moduleKey === "flatten_object") {
    const parsed = parseJsonSample(sampleValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>).slice(0, 12).map((key) => ({
      input: sourceColumn.sourceName,
      operation: "Extract JSONPath",
      output: `${getOutputName(sourceColumn)}_${safeColumnName(key)}`,
      params: `$.${key}`,
      type: inferScalarType((parsed as Record<string, unknown>)[key]),
    }));
  }
  return [];
}

function unquoteSqlIdentifier(value: string) {
  return String(value)
    .trim()
    .replace(/,$/, "")
    .replace(/^"|"$/g, "")
    .replace(/""/g, "\"");
}

function findProjectionColumn(columns: SchemaColumnDraft[], inputExpression: string, output: string) {
  const normalizedInput = unquoteSqlIdentifier(inputExpression);
  return columns.find((column) => (
    column.sourceName === normalizedInput
    || getOutputName(column) === output
    || inputExpression.includes(column.sourceName)
    || inputExpression.includes(getOutputName(column))
  ));
}

function inferProjectionOperation(inputExpression: string, column?: SchemaColumnDraft) {
  if (/JSON_VALUE/i.test(inputExpression)) return "Extract JSONPath";
  if (!column) return undefined;
  return castOperationForType(column.type);
}

function jsonPathFromSqlExpression(inputExpression: string) {
  const match = inputExpression.match(/JSON_VALUE\([^,]+,\s*'([^']+)'\)/i);
  return match?.[1] ?? "$";
}

function castOperationForType(type: string) {
  const normalized = type.toLowerCase();
  if (["integer", "long"].includes(normalized)) return "Cast Integer";
  if (["float", "double"].includes(normalized)) return "Cast Number";
  if (normalized === "boolean") return "Cast Boolean";
  if (normalized === "timestamp" || normalized === "date") return "Parse Timestamp";
  if (normalized === "string") return "Cast String";
  if (normalized === "json") return "Preserve JSON";
  return undefined;
}

function projectionToStep(projection: TransformProjection): TransformStepDraft | undefined {
  if (!projection.operation) return undefined;
  return {
    enabled: true,
    id: `schema-${projection.output}`,
    input: projection.input,
    kind: projection.operation === "Extract JSONPath" ? "jsonPath" : projection.operation === "Preserve JSON" ? "derive" : "cast",
    label: `${projection.operation}: ${projection.output}`,
    onError: "Warn",
    operation: projection.operation,
    output: projection.output,
    params: projection.params ?? projection.type ?? "",
  };
}

function uniqueProjectionOutput(column: SchemaColumnDraft, suffix: string) {
  return `${getOutputName(column)}_${suffix}`;
}

function safeColumnName(value: string) {
  return String(value)
    .trim()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "field";
}

function inferScalarType(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? "Integer" : "Float";
  if (typeof value === "boolean") return "Boolean";
  if (value && typeof value === "object") return "JSON";
  if (typeof value === "string") {
    if (!Number.isNaN(Date.parse(value))) return "Timestamp";
    if (/^-?\d+$/.test(value)) return "Integer";
    if (/^-?\d+\.\d+$/.test(value)) return "Float";
  }
  return "String";
}

function sqlSourceExpression(column: SchemaColumnDraft) {
  if (/[.[\]]/.test(column.sourceName)) return `JSON_VALUE(source, '${jsonPathForSource(column.sourceName)}')`;
  if (column.type.toLowerCase() === "json") return `JSON_QUERY(${sqlIdentifier(column.sourceName)}, '$')`;
  return sqlIdentifier(column.sourceName);
}

function sqlIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function jsonPathForSource(value: string) {
  const parts = displaySourcePath(value).split(" / ").filter(Boolean);
  return `$.${parts.map((part) => (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part) ? part : `"${part.replace(/"/g, '\\"')}"`)).join(".")}`;
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

function buildOutputPreviewTableRows(columns: string[], rows: string[][]): OutputPreviewRow[] {
  return rows.map((row, rowIndex) => {
    const record: OutputPreviewRow = { __rowId: String(rowIndex + 1) };
    columns.forEach((column, columnIndex) => {
      record[outputPreviewColumnKey(column, columnIndex)] = row[columnIndex] ?? "";
    });
    return record;
  });
}

function outputPreviewColumnKey(column: string, index: number) {
  return `${index}-${column}`;
}

function formatOutputTableCell(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "null";
  if (normalized.length > 120) return `${normalized.slice(0, 117)}...`;
  return normalized;
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
