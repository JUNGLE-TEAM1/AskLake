import type { CatalogDataset } from "../../types";

export function SqlDatasetSchemaPreview({ dataset }: { dataset: CatalogDataset }) {
  return (
    <div className="sql-table-schema-preview" aria-label={`${dataset.name} 스키마 미리보기`}>
      <div className="sql-table-schema-preview-header">
        <span>스키마</span>
        <strong>{dataset.schema.length} 컬럼</strong>
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
  );
}
