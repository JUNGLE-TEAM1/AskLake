import { Plus, X } from "lucide-react";
import type { CatalogDataset } from "../../types";

export function SchemaDetailsPanel({
  dataset,
  selectedDatasets,
  onColumnClick,
  onSelectedDatasetRemove,
  onSchemaSelect,
}: {
  dataset: CatalogDataset | null;
  selectedDatasets: CatalogDataset[];
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
  onSelectedDatasetRemove: (dataset: CatalogDataset) => void;
  onSchemaSelect: (dataset: CatalogDataset) => void;
}) {
  if (!dataset) {
    return (
      <aside className="sql-schema-panel empty">
        <header className="sql-schema-panel-header">
          <span>스키마</span>
          <h2>선택된 테이블 없음</h2>
        </header>
        <div className="sql-schema-panel-empty">
          <strong>선택 없음</strong>
          <span>소스, 담당자, 컬럼 정보</span>
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
                  <em>{item.schema.length}컬럼</em>
                </button>
                <button
                  aria-label={`${item.name} 선택 해제`}
                  className="sql-selected-dataset-remove"
                  onClick={() => onSelectedDatasetRemove(item)}
                  title="선택 해제"
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
        <span>선택한 테이블 스키마</span>
        <h2 title={dataset.name}>{dataset.name}</h2>
        <div className="sql-schema-panel-pills">
          <span className="sql-table-layer">{dataset.layer}</span>
          <span className="sql-table-layer">{dataset.schema.length} 컬럼</span>
          {dataset.rag && <span className="sql-table-rag-pill">RAG</span>}
        </div>
      </header>
      <SelectedSchemaColumnList dataset={dataset} onColumnClick={onColumnClick} />
    </aside>
  );
}

function SelectedSchemaColumnList({
  dataset,
  onColumnClick,
}: {
  dataset: CatalogDataset;
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
}) {
  return (
    <div className="sql-card-schema">
      {dataset.schema.map(([name, type], index) => (
        <div
          className="sql-card-schema-row"
          key={`${dataset.id}-${name}-${index}`}
        >
          <span className="sql-card-schema-name" title={name}>
            <strong>{name}</strong>
          </span>
          <span className="sql-card-schema-type-group">
            <em title={type}>{type}</em>
            <button
              aria-label={`${dataset.name}.${name} 컬럼 SQL에 삽입`}
              className="sql-card-schema-insert"
              title="SQL에 삽입"
              type="button"
              onClick={() => onColumnClick(dataset, name)}
            >
              <Plus size={18} strokeWidth={2.8} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
