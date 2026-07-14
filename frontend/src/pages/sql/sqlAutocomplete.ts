import type { CatalogDataset } from "../../types";
import {
  getColumnSqlReference,
  getDatasetSqlReference,
  getQualifiedColumnSqlReference,
} from "./sqlIdentifiers";

export type AutocompleteKind = "keyword" | "table" | "column";

export type AutocompleteCandidate = {
  id: string;
  type: AutocompleteKind;
  label: string;
  insertText: string;
  detail: string;
  datasetId?: string;
};

export type AutocompleteContext = {
  token: string;
  start: number;
  end: number;
  mode: "table" | "column" | "general";
  key: string;
};

const SQL_AUTOCOMPLETE_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY",
  "LIMIT", "COUNT", "SUM", "AVG", "MIN", "MAX",
];

export function getAutocompleteContext(query: string, cursorIndex: number): AutocompleteContext {
  const end = Math.max(0, Math.min(cursorIndex, query.length));
  const beforeCursor = query.slice(0, end);
  const tokenMatch = beforeCursor.match(/[\p{L}\p{N}_.-]*$/u);
  const token = tokenMatch?.[0] ?? "";
  const start = end - token.length;
  const beforeToken = query.slice(0, start);
  const statementPrefix = beforeToken.split(";").pop() ?? "";
  const tableContext = /(?:^|[\s,(])(?:from|join)\s*$/i.test(statementPrefix);
  const columnContext = /(?:^|[\s,(])(?:select|where|on|having|and|or)\s*$/i.test(statementPrefix)
    || /\b(?:select|where|on|group\s+by|order\s+by|having)\b/i.test(statementPrefix);
  const mode = tableContext ? "table" : columnContext ? "column" : "general";
  return { token, start, end, mode, key: `${start}:${end}:${mode}:${token}` };
}

export function buildAutocompleteCandidates({
  baseDataset,
  context,
  datasets,
  referenceDatasetIdSet,
}: {
  baseDataset: CatalogDataset;
  context: AutocompleteContext;
  datasets: CatalogDataset[];
  referenceDatasetIdSet: Set<string>;
}) {
  const token = context.token.toLowerCase();
  if (!token && context.mode === "general") return [];
  const canShowForToken = (value: string) => !token || value.toLowerCase().includes(token);
  const contextDatasets = [
    baseDataset,
    ...datasets.filter((item) => referenceDatasetIdSet.has(item.id) && item.id !== baseDataset.id),
  ];
  const tableCandidates: AutocompleteCandidate[] = contextDatasets
    .filter((item) => canShowForToken(item.name))
    .sort((left, right) => getDatasetContextRank(left.id, baseDataset.id, referenceDatasetIdSet) - getDatasetContextRank(right.id, baseDataset.id, referenceDatasetIdSet))
    .map((item) => ({
      id: `table-${item.id}`,
      type: "table",
      label: item.name,
      insertText: getDatasetSqlReference(item),
      detail: "table · selected",
      datasetId: item.id,
    }));
  const columnCandidates = contextDatasets.flatMap((item) => item.schema.flatMap(([name, type]) => {
    const candidates: AutocompleteCandidate[] = [];
    if (canShowForToken(name)) {
      candidates.push({
        id: `column-${item.id}-${name}`,
        type: "column",
        label: name,
        insertText: getColumnSqlReference(name),
        detail: `column · ${item.name} · ${type}`,
        datasetId: item.id,
      });
    }
    const qualifiedName = `${item.name}.${name}`;
    if (context.token.includes(".") && canShowForToken(qualifiedName)) {
      candidates.push({
        id: `column-qualified-${item.id}-${name}`,
        type: "column",
        label: qualifiedName,
        insertText: getQualifiedColumnSqlReference(item, name),
        detail: `column · ${type}`,
        datasetId: item.id,
      });
    }
    return candidates;
  }));
  const keywordCandidates: AutocompleteCandidate[] = SQL_AUTOCOMPLETE_KEYWORDS
    .filter((keyword) => canShowForToken(keyword))
    .map((keyword) => ({
      id: `keyword-${keyword}`,
      type: "keyword",
      label: keyword,
      insertText: `${keyword} `,
      detail: "keyword",
    }));
  const groups = context.mode === "table"
    ? [tableCandidates, columnCandidates, keywordCandidates]
    : context.mode === "column"
      ? [columnCandidates, tableCandidates, keywordCandidates]
      : [keywordCandidates, tableCandidates, columnCandidates];
  return groups.flat().slice(0, 8);
}

function getDatasetContextRank(datasetId: string, baseDatasetId: string, referenceDatasetIdSet: Set<string>) {
  if (datasetId === baseDatasetId) return 0;
  if (referenceDatasetIdSet.has(datasetId)) return 1;
  return 2;
}
