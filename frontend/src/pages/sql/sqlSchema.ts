import type { CatalogDataset } from "../../types";

export type SelectedSchemaRow = {
  columnKey: string;
  datasetNames: string[];
  displayType: string;
  name: string;
  occurrenceCount: number;
  primaryDataset: CatalogDataset;
  types: string[];
};

type MutableSelectedSchemaRow = SelectedSchemaRow & {
  datasetIds: Set<string>;
};

export function buildSelectedSchemaRows(datasets: CatalogDataset[]): SelectedSchemaRow[] {
  const rowMap = new Map<string, MutableSelectedSchemaRow>();

  datasets.forEach((dataset) => {
    dataset.schema.forEach(([name, type]) => {
      const columnKey = normalizeSchemaColumnName(name);
      const existing = rowMap.get(columnKey);
      if (!existing) {
        rowMap.set(columnKey, {
          columnKey,
          datasetIds: new Set([dataset.id]),
          datasetNames: [dataset.name],
          displayType: type,
          name,
          occurrenceCount: 1,
          primaryDataset: dataset,
          types: [type],
        });
        return;
      }

      if (!existing.datasetIds.has(dataset.id)) {
        existing.datasetIds.add(dataset.id);
        existing.datasetNames.push(dataset.name);
        existing.occurrenceCount = existing.datasetIds.size;
      }
      if (!existing.types.includes(type)) existing.types.push(type);
      existing.displayType = formatSchemaTypeLabel(existing.types);
    });
  });

  return Array.from(rowMap.values()).map(({ datasetIds: _datasetIds, ...row }) => row);
}

export function countDuplicateSchemaRows(rows: SelectedSchemaRow[]) {
  return rows.filter((row) => row.occurrenceCount > 1).length;
}

function normalizeSchemaColumnName(name: string) {
  return name.trim().toLowerCase();
}

function formatSchemaTypeLabel(types: string[]) {
  return types.length > 1 ? `${types[0]} +${types.length - 1}` : types[0];
}
