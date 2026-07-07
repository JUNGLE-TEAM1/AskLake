import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  FileText,
  Table2,
} from "lucide-react";
import type { SchemaColumnDraft } from "../../types";

const TYPE_OPTIONS = ["String", "Integer", "Long", "Float", "Double", "Boolean", "Timestamp", "Date", "JSON"];

type XFlowSchemaTransformEditorProps = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  selectedIndex: number;
  sourceFormat: string;
  onColumnsChange: (columns: SchemaColumnDraft[], sampleRows?: string[][]) => void;
  onSelectedIndexChange: (index: number) => void;
};

export function XFlowSchemaTransformEditor({
  columns,
  sampleRows,
  selectedIndex,
  sourceFormat,
  onColumnsChange,
  onSelectedIndexChange,
}: XFlowSchemaTransformEditorProps) {
  const [selectedBefore, setSelectedBefore] = useState<Set<number>>(new Set());
  const [selectedAfter, setSelectedAfter] = useState<Set<number>>(new Set());

  const includedIndexes = useMemo(
    () => columns.map((column, index) => ({ column, index })).filter(({ column }) => column.included !== false),
    [columns],
  );

  const selectedBeforeCount = selectedBefore.size;
  const selectedAfterCount = selectedAfter.size;

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
    const nextColumns = columns.map((column, index) => (
      selected.has(index) ? { ...column, included: false } : column
    ));
    updateColumns(nextColumns);
    setSelectedAfter(new Set());
    const nextSelected = nextColumns.findIndex((column) => column.included !== false);
    onSelectedIndexChange(Math.max(0, nextSelected));
  };

  const moveAllToLeft = () => {
    updateColumns(columns.map((column) => ({ ...column, included: false })));
    setSelectedAfter(new Set());
    onSelectedIndexChange(0);
  };

  const updateColumn = (index: number, patch: Partial<SchemaColumnDraft>) => {
    const nextColumns = columns.map((column, columnIndex) => (
      columnIndex === index ? { ...column, ...patch } : column
    ));
    updateColumns(nextColumns);
    onSelectedIndexChange(index);
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
      <div className="xflow-transform-tabs">
        <button className="active" type="button">Visual Transform</button>
        <button type="button" disabled>SQL Transform</button>
      </div>

      <div className="xflow-transfer-stage">
        <section className="xflow-transfer-panel">
          <header className="xflow-panel-header source">
            <FileText size={20} />
            <div>
              <h3>Before (Source)</h3>
              <span>{sourceFormat} · {columns.length} fields</span>
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
                  <span className="xflow-checkbox" aria-hidden="true">{selectedBefore.has(index) ? "✓" : ""}</span>
                  <strong title={column.sourceName}>{displayFieldName(column.sourceName)}</strong>
                  <em title={sampleValue}>{formatSampleValue(sampleValue)}</em>
                </button>
              );
            })}
            {columns.length === 0 && <div className="xflow-empty">No source fields available</div>}
          </div>
        </section>

        <div className="xflow-transfer-controls" aria-label="schema transfer controls">
          <button type="button" disabled={selectedBeforeCount === 0} onClick={moveSelectedToRight} title="Move selected to target">
            <ChevronRight size={18} />
          </button>
          <button type="button" disabled={columns.length === 0} onClick={moveAllToRight} title="Move all to target">
            <ChevronsRight size={18} />
          </button>
          <button type="button" disabled={selectedAfterCount === 0} onClick={moveSelectedToLeft} title="Remove selected from target">
            <ChevronLeft size={18} />
          </button>
          <button type="button" disabled={includedIndexes.length === 0} onClick={moveAllToLeft} title="Remove all from target">
            <ChevronsLeft size={18} />
          </button>
        </div>

        <section className="xflow-transfer-panel">
          <header className="xflow-panel-header target">
            <Table2 size={20} />
            <div>
              <h3>After (Target)</h3>
              <span>{includedIndexes.length} output · {columns.length - includedIndexes.length} excluded</span>
            </div>
          </header>
          <div className="xflow-panel-head target">
            <span>COLUMN</span>
            <span>TYPE</span>
            <span />
          </div>
          <div className="xflow-column-list">
            {includedIndexes.map(({ column, index }, orderIndex) => {
              const selected = selectedAfter.has(index) || selectedIndex === index;
              return (
                <div className={selected ? "xflow-target-row selected" : "xflow-target-row"} key={`after-${column.sourceName}-${index}`} onClick={() => onSelectedIndexChange(index)}>
                  <button className="xflow-checkbox" type="button" onClick={(event) => {
                    event.stopPropagation();
                    toggleAfter(index);
                  }}>{selectedAfter.has(index) ? "✓" : ""}</button>
                  <input
                    aria-label={`${column.sourceName} target column`}
                    value={column.targetName}
                    onChange={(event) => updateColumn(index, { targetName: event.currentTarget.value })}
                  />
                  <select value={column.type} onChange={(event) => updateColumn(index, { type: event.currentTarget.value })}>
                    {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                  <div className="xflow-row-actions">
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
            {includedIndexes.length === 0 && <div className="xflow-empty">Move fields to target to create output schema</div>}
          </div>
        </section>
      </div>
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
  return value.replace(/\./g, " └ ");
}

function formatSampleValue(value: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "null";
  if (normalized.length > 36) return `${normalized.slice(0, 33)}...`;
  return normalized;
}
