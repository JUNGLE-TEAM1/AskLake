import type { CatalogDataset, SqlResultDraft } from "../../../types";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";

const SQL_DATE_COLUMN_PATTERN = /(^|_)(date|time|at|day|month|year)($|_)/;
const SQL_NUMBER_COLUMN_PATTERN = /(amount|count|score|total|value|price|qty|quantity|rate|risk|cost|sales|revenue|rows?)/;

function finiteNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.replaceAll(",", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dashboardColumnType(type: string): DashboardDatasetColumn["type"] {
  const normalized = type.trim().toLowerCase();
  if (["date", "time", "timestamp"].some((hint) => normalized.includes(hint))) return "date";
  if (["bigint", "decimal", "double", "float", "int", "long", "number", "numeric", "real"].some((hint) => normalized.includes(hint))) return "number";
  return "string";
}

export function inferSqlResultColumnType(
  name: string,
  values: string[],
): DashboardDatasetColumn["type"] {
  const normalizedName = name.trim().toLowerCase();
  const populatedValues = values.filter((value) => value.trim().length > 0);

  if (SQL_DATE_COLUMN_PATTERN.test(normalizedName)) return "date";
  if (SQL_NUMBER_COLUMN_PATTERN.test(normalizedName)) return "number";
  if (populatedValues.length > 0 && populatedValues.every((value) => finiteNumber(value) !== null)) return "number";
  if (populatedValues.length > 0 && populatedValues.every((value) => Number.isFinite(Date.parse(value)))) return "date";
  return "string";
}

export function catalogDatasetToDashboardOption(dataset: CatalogDataset): DashboardDatasetOption {
  const columns = dataset.schema.map(([name, type]) => ({
    name,
    type: dashboardColumnType(type),
  }));
  return {
    columns,
    description: dataset.description,
    id: dataset.id,
    layer: dataset.layer,
    name: dataset.name,
    status: dataset.status,
    updatedAt: dataset.lastUpdated,
  };
}

export function sqlResultToDashboardOption(sqlResult: SqlResultDraft): DashboardDatasetOption {
  // SQL result state can briefly contain a query-run snapshot while a Trino
  // result page is still being collected. Keep this adapter a safe rendering
  // boundary so a stale/incomplete snapshot cannot take down the whole page.
  const resultColumns = Array.isArray(sqlResult.columns) ? sqlResult.columns : [];
  const resultRows = Array.isArray(sqlResult.rows)
    ? sqlResult.rows.filter((row): row is string[] => Array.isArray(row))
    : [];
  const columns = resultColumns.map((name, columnIndex) => ({
    name,
    type: inferSqlResultColumnType(
      name,
      resultRows.map((row) => row[columnIndex] ?? ""),
    ),
  }));
  const rows = resultRows.map((row) => Object.fromEntries(columns.map((column, index) => {
    const value = row[index] ?? "";
    const numberValue = column.type === "number" ? finiteNumber(value) : null;
    return [column.name, numberValue ?? value];
  })));

  return {
    columns,
    description: `SQL 실행 ${sqlResult.runId} 결과`,
    id: `sql-result-${sqlResult.runId}`,
    layer: "GOLD",
    name: sqlResult.datasetName,
    rows,
    status: "available",
  };
}

export function isUsableDashboardDataset(dataset: CatalogDataset) {
  return dataset.status === "available"
    && dataset.schema.length > 0
    && dataset.permissions?.canQuery !== false;
}
