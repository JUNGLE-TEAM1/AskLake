import { X } from "lucide-react";
import type { CatalogDataset } from "../../types";

export function SchemaDetailsPanel({
  dataset,
  selectedDatasets,
  onColumnClick,
  onInsert,
  onSelectedDatasetRemove,
  onSchemaSelect,
}: {
  dataset: CatalogDataset | null;
  selectedDatasets: CatalogDataset[];
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
  onInsert: (dataset: CatalogDataset) => void;
  onSelectedDatasetRemove: (dataset: CatalogDataset) => void;
  onSchemaSelect: (dataset: CatalogDataset) => void;
}) {
  const canRemoveDataset = selectedDatasets.length > 1;

  if (!dataset) {
    return (
      <aside className="sql-schema-panel empty">
        <header className="sql-schema-panel-header">
          <span>SCHEMA</span>
          <h2>선택된 테이블 없음</h2>
        </header>
        <div className="sql-schema-panel-empty">
          <strong>선택 없음</strong>
          <span>Source, owner, columns</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sql-schema-panel">
      <section className="sql-selected-datasets-panel" aria-label="선택 테이블">
        <div className="sql-selected-datasets-header">
          <span>선택 테이블</span>
          <strong>{selectedDatasets.length}개 선택됨</strong>
        </div>
        <div className="sql-selected-dataset-list">
          {selectedDatasets.map((item, index) => {
            const active = item.id === dataset.id;
            return (
              <div className={active ? "sql-selected-dataset-item active" : "sql-selected-dataset-item"} key={item.id}>
                <button
                  aria-pressed={active}
                  className="sql-selected-dataset-main"
                  type="button"
                  onClick={() => onSchemaSelect(item)}
                >
                  <span>{index + 1}</span>
                  <strong title={item.name}>{item.name}</strong>
                  <em>{item.schema.length} cols</em>
                </button>
                <button
                  aria-label={`${item.name} 선택 해제`}
                  className="sql-selected-dataset-remove"
                  disabled={!canRemoveDataset}
                  onClick={() => onSelectedDatasetRemove(item)}
                  title={canRemoveDataset ? "선택 해제" : "최소 1개 테이블은 필요합니다"}
                  type="button"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <header className="sql-schema-panel-header">
        <span>SCHEMA</span>
        <h2 title={dataset.name}>{dataset.name}</h2>
        <div className="sql-schema-panel-pills">
          <span className="sql-table-layer">{dataset.layer}</span>
          {dataset.rag && <span className="sql-table-rag-pill">RAG</span>}
        </div>
      </header>
      <dl className="sql-schema-panel-meta">
        <div>
          <dt>Source</dt>
          <dd title={dataset.source}>{dataset.source}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd title={dataset.owner}>{dataset.owner}</dd>
        </div>
        <div>
          <dt>Columns</dt>
          <dd>{dataset.schema.length}</dd>
        </div>
      </dl>
      <div className="sql-schema-panel-actions">
        <button type="button" onClick={() => onInsert(dataset)}>SQL에 삽입</button>
        <button
          disabled={!canRemoveDataset}
          onClick={() => onSelectedDatasetRemove(dataset)}
          title={canRemoveDataset ? "선택 테이블에서 제거" : "최소 1개 테이블은 필요합니다"}
          type="button"
        >
          선택 해제
        </button>
      </div>
      <SchemaColumnList dataset={dataset} onColumnClick={onColumnClick} />
    </aside>
  );
}

function SchemaColumnList({
  dataset,
  onColumnClick,
}: {
  dataset: CatalogDataset;
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
}) {
  return (
    <div className="sql-card-schema">
      {dataset.schema.map(([name, type], index) => (
        <button key={`${dataset.id}-${name}-${index}`} type="button" onClick={() => onColumnClick(dataset, name)}>
          <span title={name}>{name}</span>
          <em title={type}>{type}</em>
        </button>
      ))}
    </div>
  );
}
