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
  const schemaRows = buildSelectedSchemaRows(selectedDatasets);
  const duplicateColumnCount = schemaRows.filter((row) => row.occurrenceCount > 1).length;

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
        <h2>전체 선택 테이블 스키마</h2>
        <div className="sql-schema-panel-pills">
          <span className="sql-table-layer">{selectedDatasets.length} tables</span>
          {duplicateColumnCount > 0 && <span className="sql-table-rag-pill">{duplicateColumnCount} duplicates</span>}
        </div>
      </header>
      <dl className="sql-schema-panel-meta">
        <div>
          <dt>Active</dt>
          <dd title={dataset.name}>{dataset.name}</dd>
        </div>
        <div>
          <dt>Tables</dt>
          <dd>{selectedDatasets.length}</dd>
        </div>
        <div>
          <dt>Columns</dt>
          <dd>{schemaRows.length}</dd>
        </div>
      </dl>
      <div className="sql-schema-panel-actions">
        <button type="button" onClick={() => onInsert(dataset)}>활성 테이블 SQL에 삽입</button>
        <button
          disabled={!canRemoveDataset}
          onClick={() => onSelectedDatasetRemove(dataset)}
          title={canRemoveDataset ? "선택 테이블에서 제거" : "최소 1개 테이블은 필요합니다"}
          type="button"
        >
          선택 해제
        </button>
      </div>
      <SelectedSchemaColumnList rows={schemaRows} onColumnClick={onColumnClick} />
    </aside>
  );
}

type SelectedSchemaRow = {
  datasetNames: string[];
  displayType: string;
  name: string;
  occurrenceCount: number;
  primaryDataset: CatalogDataset;
  types: string[];
};

function buildSelectedSchemaRows(datasets: CatalogDataset[]): SelectedSchemaRow[] {
  const rowMap = new Map<string, SelectedSchemaRow>();

  datasets.forEach((dataset) => {
    dataset.schema.forEach(([name, type]) => {
      const key = name.toLowerCase();
      const existing = rowMap.get(key);
      if (!existing) {
        rowMap.set(key, {
          datasetNames: [dataset.name],
          displayType: type,
          name,
          occurrenceCount: 1,
          primaryDataset: dataset,
          types: [type],
        });
        return;
      }

      existing.occurrenceCount += 1;
      if (!existing.datasetNames.includes(dataset.name)) existing.datasetNames.push(dataset.name);
      if (!existing.types.includes(type)) existing.types.push(type);
      existing.displayType = existing.types.length > 1 ? `${existing.types[0]} +${existing.types.length - 1}` : existing.types[0];
    });
  });

  return Array.from(rowMap.values());
}

function SelectedSchemaColumnList({
  rows,
  onColumnClick,
}: {
  rows: SelectedSchemaRow[];
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
}) {
  return (
    <div className="sql-card-schema">
      {rows.map((row) => (
        <button key={row.name.toLowerCase()} type="button" onClick={() => onColumnClick(row.primaryDataset, row.name)}>
          <span className="sql-card-schema-name" title={`${row.name} · ${row.datasetNames.join(", ")}`}>
            <strong>{row.name}</strong>
            <small>{row.datasetNames.join(", ")}</small>
          </span>
          <span className="sql-card-schema-type-group">
            <em title={row.types.join(", ")}>{row.displayType}</em>
            {row.occurrenceCount > 1 && (
              <b className="sql-schema-duplicate-count" title={`${row.occurrenceCount}개 선택 테이블에 존재`}>
                {row.occurrenceCount}
              </b>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
