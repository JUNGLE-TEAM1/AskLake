import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { CatalogDataset } from "../../types";
import { SqlDatasetSchemaPreview } from "./SqlDatasetSchemaPreview";

type SqlDatasetRowProps = {
  dataset: CatalogDataset;
  expanded: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
};

export function SqlDatasetRow({
  dataset,
  expanded,
  onSelect,
  onToggle,
}: SqlDatasetRowProps) {
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
      {expanded && <SqlDatasetSchemaPreview dataset={dataset} />}
    </article>
  );
}
