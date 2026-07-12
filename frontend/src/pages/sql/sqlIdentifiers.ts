import type { CatalogDataset } from "../../types";

export function quoteSqlIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (isQuotedSqlIdentifier(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

export function getDatasetSqlReference(dataset: CatalogDataset) {
  return quoteSqlIdentifier(dataset.name);
}

export function getColumnSqlReference(columnName: string) {
  return quoteSqlIdentifier(columnName);
}

export function getQualifiedColumnSqlReference(dataset: CatalogDataset, columnName: string) {
  return `${getDatasetSqlReference(dataset)}.${getColumnSqlReference(columnName)}`;
}

export function isQuotedSqlIdentifier(identifier: string) {
  return identifier.length >= 2 && identifier.startsWith('"') && identifier.endsWith('"');
}

export function needsQuotedIdentifier(identifier: string) {
  return !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(identifier);
}

export function normalizeSqlIdentifier(identifier: string) {
  return stripSqlIdentifier(identifier.trim()).toLowerCase();
}

function stripSqlIdentifier(identifier: string) {
  if (identifier.length >= 2 && identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  if (identifier.length >= 2 && identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1);
  }
  if (identifier.length >= 2 && identifier.startsWith("[") && identifier.endsWith("]")) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

export function getColumnInsertText(
  dataset: CatalogDataset,
  columnName: string,
  selectedDatasets: CatalogDataset[],
) {
  const normalizedColumnName = columnName.trim().toLowerCase();
  const matchingDatasetCount = selectedDatasets.filter((item) => (
    item.schema.some(([name]) => name.trim().toLowerCase() === normalizedColumnName)
  )).length;

  return matchingDatasetCount > 1
    ? getQualifiedColumnSqlReference(dataset, columnName)
    : getColumnSqlReference(columnName);
}
