import { Plus } from "lucide-react";
import type { CatalogDataset } from "../../types";

export function SqlDatasetRow({
  dataset,
  onSelect,
}: {
  dataset: CatalogDataset;
  onSelect: (dataset: CatalogDataset) => void;
}) {
  return (
    <article className="sql-table-card">
      <button className="sql-table-row" type="button" aria-label={`${dataset.name} 선택 테이블에 추가`} onClick={() => onSelect(dataset)}>
        <span className="sql-table-add-icon"><Plus size={14} /></span>
        <span className="sql-table-name">
          <strong title={dataset.name}>{dataset.name}</strong>
        </span>
        <span className="sql-table-pills">
          <span className="sql-table-layer">{dataset.layer}</span>
          {dataset.rag && <span className="sql-table-rag-pill">RAG</span>}
        </span>
      </button>
    </article>
  );
}
