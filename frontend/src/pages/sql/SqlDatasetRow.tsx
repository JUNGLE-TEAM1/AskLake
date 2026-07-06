import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { CatalogDataset } from "../../types";

export function SqlDatasetRow({
  dataset,
  expanded,
  onSelect,
  onToggle,
}: {
  dataset: CatalogDataset;
  expanded: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
}) {
  return (
    <article className={expanded ? "sql-table-card active expanded" : "sql-table-card"}>
      <div className="sql-table-row-shell">
        <button
          aria-expanded={expanded}
          className="sql-table-row"
          type="button"
          onClick={() => onToggle(dataset)}
        >
          <span className="sql-table-expand-icon">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="sql-table-name">
            <strong title={dataset.name}>{dataset.name}</strong>
          </span>
          <span className="sql-table-pills">
            <span className="sql-table-layer">{dataset.layer}</span>
            {dataset.rag && <span className="sql-table-rag-pill">RAG</span>}
          </span>
        </button>
        <button className="sql-table-select-button" type="button" aria-label={`${dataset.name} 선택 테이블에 추가`} onClick={() => onSelect(dataset)}>
          <Plus size={13} /> 선택
        </button>
      </div>
      {expanded && (
        <div className="sql-table-schema-preview" aria-label={`${dataset.name} 스키마 미리보기`}>
          <div className="sql-table-schema-preview-header">
            <span>SCHEMA</span>
            <strong>{dataset.schema.length} columns</strong>
          </div>
          <div className="sql-table-schema-preview-list">
            {dataset.schema.map(([name, type], index) => (
              <div key={`${dataset.id}-${name}-${index}`}>
                <span title={name}>{name}</span>
                <em title={type}>{type}</em>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
