import type { CatalogDataset } from "../../types";
import {
  getColumnSqlReference,
  getDatasetSqlReference,
  getQualifiedColumnSqlReference,
  normalizeSqlIdentifier,
  quoteSqlIdentifier,
} from "./sqlIdentifiers";

export function buildDefaultQuery(dataset: CatalogDataset) {
  const columns = dataset.schema.slice(0, 4).map(([name]) => quoteSqlIdentifier(name)).join(", ") || "*";
  return `SELECT ${columns}\nFROM ${getDatasetSqlReference(dataset)}\nLIMIT 100;`;
}

type JoinEdge = {
  leftColumn: string;
  leftDataset: CatalogDataset;
  rightColumn: string;
  rightDataset: CatalogDataset;
  score: number;
};

type JoinPlan = {
  extraDatasets: CatalogDataset[];
  joins: JoinEdge[];
};

export type JoinDraftResult = {
  query: string;
  addedDatasetIds: string[];
  joined: boolean;
};

export function buildJoinDraftQuery({
  allDatasets,
  includeUnresolvedComment = true,
  query,
  selectedDatasets,
  targetDataset,
}: {
  allDatasets: CatalogDataset[];
  includeUnresolvedComment?: boolean;
  query: string;
  selectedDatasets: CatalogDataset[];
  targetDataset: CatalogDataset;
}): JoinDraftResult {
  const selectedDatasetIds = new Set(selectedDatasets.map((dataset) => dataset.id));
  const plan = buildJoinPlan(selectedDatasets, targetDataset, allDatasets);
  const addedDatasetIds = [
    ...plan.extraDatasets.map((dataset) => dataset.id),
    targetDataset.id,
  ].filter((id) => !selectedDatasetIds.has(id));

  if (plan.joins.length === 0) {
    return {
      addedDatasetIds,
      joined: false,
      query: includeUnresolvedComment ? appendJoinComment(query, selectedDatasets[0], targetDataset) : query,
    };
  }

  return { addedDatasetIds, joined: true, query: insertJoinClauses(query, plan.joins) };
}

export function buildSelectedDatasetsJoinDraftQuery({
  allDatasets,
  query,
  selectedDatasets,
}: {
  allDatasets: CatalogDataset[];
  query: string;
  selectedDatasets: CatalogDataset[];
}): JoinDraftResult {
  const [baseDataset, ...targetDatasets] = selectedDatasets;
  if (!baseDataset || targetDatasets.length === 0) {
    return { addedDatasetIds: [], joined: false, query };
  }

  const addedDatasetIds = new Set<string>();
  const selectedSoFar: CatalogDataset[] = [baseDataset];
  let joined = false;
  let nextQuery = query;

  targetDatasets.forEach((targetDataset) => {
    if (queryReferencesDataset(nextQuery, targetDataset)) {
      selectedSoFar.push(targetDataset);
      return;
    }

    const draft = buildJoinDraftQuery({
      allDatasets,
      includeUnresolvedComment: false,
      query: nextQuery,
      selectedDatasets: selectedSoFar,
      targetDataset,
    });
    if (!draft.joined) return;

    nextQuery = draft.query;
    joined = true;
    draft.addedDatasetIds.forEach((datasetId) => addedDatasetIds.add(datasetId));
    draft.addedDatasetIds
      .map((datasetId) => allDatasets.find((dataset) => dataset.id === datasetId))
      .filter((dataset): dataset is CatalogDataset => Boolean(dataset))
      .forEach((dataset) => {
        if (!selectedSoFar.some((item) => item.id === dataset.id)) selectedSoFar.push(dataset);
      });
    if (!selectedSoFar.some((item) => item.id === targetDataset.id)) selectedSoFar.push(targetDataset);
  });

  return { addedDatasetIds: Array.from(addedDatasetIds), joined, query: nextQuery };
}

function buildJoinPlan(
  selectedDatasets: CatalogDataset[],
  targetDataset: CatalogDataset,
  allDatasets: CatalogDataset[],
): JoinPlan {
  const directJoin = findBestJoinToSelected(selectedDatasets, targetDataset);
  if (directJoin) return { extraDatasets: [], joins: [directJoin] };

  const selectedDatasetIds = new Set(selectedDatasets.map((dataset) => dataset.id));
  const bridgePlan = allDatasets
    .filter((dataset) => dataset.id !== targetDataset.id && !selectedDatasetIds.has(dataset.id))
    .map((bridgeDataset) => {
      const firstJoin = findBestJoinToSelected(selectedDatasets, bridgeDataset);
      if (!firstJoin) return null;
      const secondJoin = findBestJoinEdge(bridgeDataset, targetDataset);
      if (!secondJoin) return null;
      return { bridgeDataset, firstJoin, score: firstJoin.score + secondJoin.score, secondJoin };
    })
    .filter((plan): plan is {
      bridgeDataset: CatalogDataset;
      firstJoin: JoinEdge;
      score: number;
      secondJoin: JoinEdge;
    } => Boolean(plan))
    .sort((left, right) => right.score - left.score)[0];

  if (bridgePlan) {
    return {
      extraDatasets: [bridgePlan.bridgeDataset],
      joins: [bridgePlan.firstJoin, bridgePlan.secondJoin],
    };
  }
  return { extraDatasets: [], joins: [] };
}

function findBestJoinToSelected(selectedDatasets: CatalogDataset[], targetDataset: CatalogDataset) {
  return selectedDatasets
    .map((dataset) => findBestJoinEdge(dataset, targetDataset))
    .filter((edge): edge is JoinEdge => Boolean(edge))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function findBestJoinEdge(leftDataset: CatalogDataset, rightDataset: CatalogDataset): JoinEdge | null {
  const rightColumnsByName = new Map(
    rightDataset.schema.map(([name]) => [normalizeColumnName(name), name]),
  );
  const candidates = leftDataset.schema
    .map(([leftColumn]) => {
      const rightColumn = rightColumnsByName.get(normalizeColumnName(leftColumn));
      if (!rightColumn) return null;
      return { leftColumn, leftDataset, rightColumn, rightDataset, score: joinColumnScore(leftColumn) };
    })
    .filter((edge): edge is JoinEdge => Boolean(edge))
    .sort((left, right) => right.score - left.score);
  return candidates[0] ?? null;
}

function normalizeColumnName(columnName: string) {
  return columnName.trim().toLowerCase();
}

function joinColumnScore(columnName: string) {
  const normalized = normalizeColumnName(columnName);
  if (normalized.endsWith("_id")) return 100;
  if (normalized.endsWith("_key")) return 90;
  if (normalized === "id") return 80;
  if (normalized.includes("_id_")) return 70;
  if (normalized.includes("id")) return 60;
  return 10;
}

function insertJoinClauses(query: string, joins: JoinEdge[]) {
  const cleanedQuery = query.trim();
  const baseQuery = qualifyAmbiguousSelectColumns(
    (cleanedQuery || buildDefaultQuery(joins[0].leftDataset)).replace(/;\s*$/, ""),
    joins,
  );
  const existingTables = new Set(extractReferencedTableNamesFromText(baseQuery));
  const joinText = joins
    .filter((join) => !existingTables.has(normalizeSqlIdentifier(join.rightDataset.name)))
    .map((join) => (
      `JOIN ${getDatasetSqlReference(join.rightDataset)} ON `
      + `${getQualifiedColumnSqlReference(join.leftDataset, join.leftColumn)} = ${getQualifiedColumnSqlReference(join.rightDataset, join.rightColumn)}`
    ))
    .join("\n");

  if (!joinText) return `${baseQuery};`;
  const insertBeforeMatch = baseQuery.match(/\n?\b(where|group\s+by|having|order\s+by|limit)\b/i);
  if (!insertBeforeMatch || insertBeforeMatch.index === undefined) return `${baseQuery}\n${joinText};`;
  const before = baseQuery.slice(0, insertBeforeMatch.index).trimEnd();
  const after = baseQuery.slice(insertBeforeMatch.index).trimStart();
  return `${before}\n${joinText}\n${after};`;
}

function qualifyAmbiguousSelectColumns(query: string, joins: JoinEdge[]) {
  const baseDataset = joins[0]?.leftDataset;
  if (!baseDataset) return query;
  const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
  if (!match || match.index === undefined) return query;
  const selectClause = match[1];
  if (!selectClause || selectClause.includes("*")) return query;

  const baseColumnNames = new Set(baseDataset.schema.map(([name]) => normalizeColumnName(name)));
  const joinedColumnNames = new Set(
    joins
      .flatMap((join) => [join.leftDataset, join.rightDataset])
      .filter((dataset) => dataset.id !== baseDataset.id)
      .flatMap((dataset) => dataset.schema.map(([name]) => normalizeColumnName(name))),
  );
  const nextSelectClause = selectClause
    .split(",")
    .map((part) => {
      const simpleColumn = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/)?.[1];
      if (!simpleColumn) return part;
      const normalizedColumn = normalizeColumnName(simpleColumn);
      if (!baseColumnNames.has(normalizedColumn) || !joinedColumnNames.has(normalizedColumn)) return part;
      return part.replace(simpleColumn, getQualifiedColumnSqlReference(baseDataset, simpleColumn));
    })
    .join(",");
  return `${query.slice(0, match.index)}${query.slice(match.index, match.index + match[0].length).replace(selectClause, nextSelectClause)}${query.slice(match.index + match[0].length)}`;
}

function queryReferencesDataset(query: string, dataset: CatalogDataset) {
  const referencedNames = new Set(extractReferencedTableNamesFromText(query));
  return [dataset.name, dataset.id]
    .map(normalizeSqlIdentifier)
    .some((name) => referencedNames.has(name));
}

function appendJoinComment(query: string, baseDataset: CatalogDataset | undefined, targetDataset: CatalogDataset) {
  const cleanedQuery = query.trim().replace(/;\s*$/, "");
  const leftDataset = baseDataset ?? targetDataset;
  const leftColumn = leftDataset.schema[0]?.[0] ?? "key";
  const rightColumn = targetDataset.schema[0]?.[0] ?? "key";
  const comment = [
    "/* JOIN 키를 자동으로 찾지 못했습니다. ON 조건을 확인해서 바꿔 주세요.",
    `JOIN ${getDatasetSqlReference(targetDataset)} ON ${getQualifiedColumnSqlReference(leftDataset, leftColumn)} = ${getQualifiedColumnSqlReference(targetDataset, rightColumn)}`,
    "*/",
  ].join("\n");
  return `${cleanedQuery || buildDefaultQuery(leftDataset).replace(/;\s*$/, "")}\n${comment};`;
}

function extractReferencedTableNamesFromText(query: string) {
  const names = new Set<string>();
  const matcher = /\b(?:from|join)\s+((?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\])|(?:[a-zA-Z_][a-zA-Z0-9_.-]*))/gi;
  let match = matcher.exec(query);
  while (match) {
    names.add(normalizeSqlIdentifier(match[1]));
    match = matcher.exec(query);
  }
  return Array.from(names);
}
