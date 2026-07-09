import postgresqlParser from "node-sql-parser/build/postgresql.js";
import type { CatalogDataset } from "../../types";

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

export type SqlPreflightMessage = {
  tone: "success" | "info" | "warning" | "error";
  text: string;
};

export type SqlPreflightResult = {
  autoFixQuery?: string;
  key: string;
  canExecute: boolean;
  messages: SqlPreflightMessage[];
};

export const PREVIEW_ROW_LIMIT = 100;
export const SQL_RESULT_PAGE_SIZE = 25;

const { Parser: SqlParser } = postgresqlParser;
const sqlParser = new SqlParser();

export function buildDefaultQuery(dataset: CatalogDataset) {
  const columns = dataset.schema.slice(0, 4).map(([name]) => quoteSqlIdentifier(name)).join(", ") || "*";
  return `SELECT ${columns}
FROM ${getDatasetSqlReference(dataset)}
LIMIT 100;`;
}

export function quoteSqlIdentifier(identifier: string) {
  const trimmed = identifier.trim();
  if (isQuotedSqlIdentifier(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

export function getDatasetSqlReference(dataset: CatalogDataset) {
  return quoteSqlIdentifier(dataset.name);
}

function getColumnSqlReference(columnName: string) {
  return quoteSqlIdentifier(columnName);
}

function getQualifiedColumnSqlReference(dataset: CatalogDataset, columnName: string) {
  return `${getDatasetSqlReference(dataset)}.${getColumnSqlReference(columnName)}`;
}

function isQuotedSqlIdentifier(identifier: string) {
  return identifier.length >= 2 && identifier.startsWith("\"") && identifier.endsWith("\"");
}

function needsQuotedIdentifier(identifier: string) {
  return !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(identifier);
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

  return {
    addedDatasetIds,
    joined: true,
    query: insertJoinClauses(query, plan.joins),
  };
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
    return {
      addedDatasetIds: [],
      joined: false,
      query,
    };
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
    if (!draft.joined) {
      return;
    }

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

  return {
    addedDatasetIds: Array.from(addedDatasetIds),
    joined,
    query: nextQuery,
  };
}

function buildJoinPlan(
  selectedDatasets: CatalogDataset[],
  targetDataset: CatalogDataset,
  allDatasets: CatalogDataset[],
): JoinPlan {
  const directJoin = findBestJoinToSelected(selectedDatasets, targetDataset);
  if (directJoin) {
    return {
      extraDatasets: [],
      joins: [directJoin],
    };
  }

  const selectedDatasetIds = new Set(selectedDatasets.map((dataset) => dataset.id));
  const bridgePlan = allDatasets
    .filter((dataset) => dataset.id !== targetDataset.id && !selectedDatasetIds.has(dataset.id))
    .map((bridgeDataset) => {
      const firstJoin = findBestJoinToSelected(selectedDatasets, bridgeDataset);
      if (!firstJoin) return null;
      const secondJoin = findBestJoinEdge(bridgeDataset, targetDataset);
      if (!secondJoin) return null;
      return {
        bridgeDataset,
        firstJoin,
        score: firstJoin.score + secondJoin.score,
        secondJoin,
      };
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

  return {
    extraDatasets: [],
    joins: [],
  };
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
      const score = joinColumnScore(leftColumn);
      return {
        leftColumn,
        leftDataset,
        rightColumn,
        rightDataset,
        score,
      };
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
  if (!insertBeforeMatch || insertBeforeMatch.index === undefined) {
    return `${baseQuery}\n${joinText};`;
  }

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
      const trimmed = part.trim();
      const simpleColumn = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/)?.[1];
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

function appendJoinComment(
  query: string,
  baseDataset: CatalogDataset | undefined,
  targetDataset: CatalogDataset,
) {
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

export function getColumnInsertText(dataset: CatalogDataset, columnName: string, selectedDatasets: CatalogDataset[]) {
  const normalizedColumnName = columnName.trim().toLowerCase();
  const matchingDatasetCount = selectedDatasets.filter((item) => (
    item.schema.some(([name]) => name.trim().toLowerCase() === normalizedColumnName)
  )).length;

  return matchingDatasetCount > 1 ? getQualifiedColumnSqlReference(dataset, columnName) : getColumnSqlReference(columnName);
}

export function buildDefaultDerivedDatasetName(dataset: CatalogDataset) {
  return `${dataset.name}_analysis`;
}

export function buildDefaultDerivedDatasetDescription(dataset: CatalogDataset) {
  return `${dataset.name} SQL 결과로 생성한 분석 데이터셋`;
}

export function buildDefaultDerivedDatasetTags(dataset: CatalogDataset) {
  return Array.from(new Set(["#sql-derived", ...dataset.tags])).slice(0, 4).join(" ");
}

export function parseDerivedDatasetTags(value: string) {
  const tags = value
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith("#") ? tag : `#${tag}`);

  return Array.from(new Set(tags));
}

export function getPreflightSummary(result: SqlPreflightResult | null) {
  if (!result) return null;
  if (result.canExecute) {
    const warningMessage = result.messages.find((message) => message.tone === "warning")?.text;
    if (warningMessage) {
      return { detail: warningMessage, label: "확인 필요", tone: "warning" as const };
    }
    return { detail: "", label: "점검 통과", tone: "success" as const };
  }
  const errorMessage = result.messages.find((message) => message.tone === "error")?.text ?? "SQL을 확인해 주세요.";
  return { detail: errorMessage, label: "점검 필요", tone: "error" as const };
}

export function runSqlPreflight(query: string, baseDataset: CatalogDataset, referenceDatasets: CatalogDataset[], key: string): SqlPreflightResult {
  const normalizedQuery = stripSqlComments(query).trim();
  const messages: SqlPreflightMessage[] = [];
  const contextDatasets = [baseDataset, ...referenceDatasets];
  if (!normalizedQuery) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "실행할 SQL을 입력해 주세요." }],
    };
  }

  const parsedQuery = parseSqlQuery(normalizedQuery);
  if (!parsedQuery.ok) {
    const autoFixQuery = buildUnquotedKoreanIdentifierFix(query, contextDatasets);
    if (autoFixQuery && autoFixQuery !== query) {
      return {
        autoFixQuery,
        key,
        canExecute: false,
        messages: [{
          tone: "error",
          text: "한글/공백이 있는 테이블명은 큰따옴표가 필요합니다. 자동 보정으로 안전한 SQL 식별자 형식을 적용할 수 있습니다.",
        }],
      };
    }
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: parsedQuery.message }],
    };
  }

  const statements = Array.isArray(parsedQuery.ast) ? parsedQuery.ast : [parsedQuery.ast];
  if (statements.length !== 1) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "실행은 단일 SELECT 문만 허용합니다." }],
    };
  }

  const statement = statements[0];
  if (!isSelectStatement(statement)) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: "읽기 전용 SQL만 실행할 수 있습니다. SELECT 또는 WITH로 시작해야 합니다." }],
    };
  }

  const limitIssue = findLimitIssue(statement);
  if (limitIssue) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: limitIssue }],
    };
  }

  const allowedTableNames = new Set(
    contextDatasets
      .flatMap((item) => [item.name, item.id])
      .map(normalizeSqlIdentifier),
  );
  const cteNames = extractCteNames(statement);
  const referencedTableNames = extractReferencedTableNames(statement);
  const unknownTableNames = referencedTableNames.filter((name) => {
    const normalizedName = normalizeSqlIdentifier(name);
    return !allowedTableNames.has(normalizedName) && !cteNames.has(normalizedName);
  });

  if (unknownTableNames.length > 0) {
    return {
      key,
      canExecute: false,
      messages: [{ tone: "error", text: `선택 테이블에 없는 테이블이 있습니다: ${unknownTableNames.join(", ")}` }],
    };
  }

  const referencedDatasetNames = new Set(referencedTableNames.map(normalizeSqlIdentifier));
  const referencedContextDatasets = contextDatasets.filter((dataset) => (
    referencedDatasetNames.has(normalizeSqlIdentifier(dataset.name))
      || referencedDatasetNames.has(normalizeSqlIdentifier(dataset.id))
  ));
  const ambiguousColumns = findAmbiguousUnqualifiedSelectColumns(
    normalizedQuery,
    referencedContextDatasets.length > 0 ? referencedContextDatasets : contextDatasets,
  );
  if (ambiguousColumns.length > 0) {
    return {
      key,
      canExecute: false,
      messages: [{
        tone: "error",
        text: `여러 선택 테이블에 같은 컬럼이 있습니다: ${ambiguousColumns.join(", ")}. 테이블명.컬럼 형식으로 작성해 주세요.`,
      }],
    };
  }

  messages.push({ tone: "success", text: `읽기 전용 SQL 확인 완료. 선택 테이블 ${referenceDatasets.length + 1}개 기준으로 JOIN 포함 실행할 수 있습니다.` });
  messages.push({ tone: "info", text: `실행 결과는 원본 SQL을 바꾸지 않고 최대 ${PREVIEW_ROW_LIMIT}행으로 제한해 표시합니다.` });
  const tableAliases = extractTableAliases(statement);
  if (tableAliases.length > 0) {
    messages.push({ tone: "warning", text: `테이블 별칭 ${tableAliases.map((alias) => `"${alias}"`).join(", ")}이 감지되었습니다. 의도한 별칭이면 실행할 수 있고, LIMIT 오타라면 수정해 주세요.` });
  }
  if (referencedTableNames.length === 0) {
    messages.push({ tone: "warning", text: "FROM/JOIN 테이블이 없습니다. 상수 조회 또는 CTE-only 쿼리인지 확인해 주세요." });
  }

  return { key, canExecute: true, messages };
}

function buildUnquotedKoreanIdentifierFix(query: string, datasets: CatalogDataset[]) {
  return datasets
    .filter((dataset) => needsQuotedIdentifier(dataset.name))
    .reduce((nextQuery, dataset) => replaceUnquotedRelationName(nextQuery, dataset.name, getDatasetSqlReference(dataset)), query);
}

function replaceUnquotedRelationName(query: string, tableName: string, quotedTableName: string) {
  const escapedName = escapeRegExp(tableName);
  const matcher = new RegExp(`\\b(from|join)\\s+(${escapedName})(?=\\s|;|$)`, "gi");
  return query.replace(matcher, (_match, keyword: string) => `${keyword} ${quotedTableName}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSqlComments(query: string) {
  return query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function findAmbiguousUnqualifiedSelectColumns(query: string, datasets: CatalogDataset[]) {
  if (datasets.length <= 1) return [];

  const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
  if (!match) return [];

  const columnCounts = new Map<string, number>();
  datasets.forEach((dataset) => {
    const datasetColumnNames = new Set(dataset.schema.map(([name]) => normalizeColumnName(name)));
    datasetColumnNames.forEach((columnName) => {
      columnCounts.set(columnName, (columnCounts.get(columnName) ?? 0) + 1);
    });
  });

  return Array.from(new Set(
    match[1]
      .split(",")
      .map((part) => part.trim())
      .map((part) => part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/)?.[1] ?? "")
      .filter((columnName) => columnName && (columnCounts.get(normalizeColumnName(columnName)) ?? 0) > 1),
  ));
}

function normalizeSqlIdentifier(identifier: string) {
  const stripped = stripSqlIdentifier(identifier.trim());
  return stripped.toLowerCase();
}

function stripSqlIdentifier(identifier: string) {
  if (identifier.length >= 2 && identifier.startsWith("\"") && identifier.endsWith("\"")) {
    return identifier.slice(1, -1).replace(/""/g, "\"");
  }
  if (identifier.length >= 2 && identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1);
  }
  if (identifier.length >= 2 && identifier.startsWith("[") && identifier.endsWith("]")) {
    return identifier.slice(1, -1);
  }
  return identifier;
}

type SqlAstNode = {
  as?: string | null;
  ast?: SqlAstNode | SqlAstNode[];
  columns?: unknown;
  db?: string | null;
  expr?: unknown;
  from?: SqlAstNode[] | null;
  limit?: { value?: Array<{ type?: string; value?: unknown }> } | null;
  name?: { value?: string } | string;
  stmt?: SqlAstNode;
  table?: string | null;
  type?: string;
  with?: SqlAstNode[] | null;
  [key: string]: unknown;
};

function parseSqlQuery(query: string): { ast: SqlAstNode | SqlAstNode[]; ok: true } | { message: string; ok: false } {
  try {
    return { ast: sqlParser.astify(query, { database: "postgresql" }) as SqlAstNode | SqlAstNode[], ok: true };
  } catch (error) {
    return {
      message: `SQL 문법 오류입니다. ${getParserErrorHint(error)}`,
      ok: false,
    };
  }
}

function getParserErrorHint(error: unknown) {
  if (isParserSyntaxError(error)) {
    const found = error.found ? ` "${error.found}"` : "";
    return `${error.location.start.line}:${error.location.start.column} 위치의${found} 토큰을 확인해 주세요.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("but") && message.includes("found")) {
    return message.replace(/\s+/g, " ");
  }
  return "문장을 확인해 주세요.";
}

function isParserSyntaxError(error: unknown): error is { found?: string; location: { start: { column: number; line: number } } } {
  return typeof error === "object"
    && error !== null
    && "location" in error
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.line === "number"
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.column === "number";
}

function isSelectStatement(statement: SqlAstNode) {
  return statement.type === "select";
}

function findLimitIssue(statement: SqlAstNode) {
  const limitValues = statement.limit?.value ?? [];
  const invalidLimit = limitValues.find((item) => item.type !== "number" || !Number.isFinite(Number(item.value)));
  return invalidLimit ? "LIMIT에는 숫자만 입력할 수 있습니다." : null;
}

function extractCteNames(statement: SqlAstNode) {
  const cteNames = new Set<string>();
  const visitedExpressions = new WeakSet<object>();
  const visitedStatements = new WeakSet<object>();

  const collectFromStatement = (node: unknown) => {
    if (!isSqlAstRecord(node) || visitedStatements.has(node)) return;
    visitedStatements.add(node);

    node.with?.forEach((cte) => {
      const cteName = typeof cte.name === "string" ? cte.name : cte.name?.value;
      if (cteName) cteNames.add(normalizeSqlIdentifier(cteName));
      collectNestedSelects(cte.stmt);
    });
    collectNestedSelects(node.from);
    collectNestedSelects(node.columns);
    collectNestedSelects(node.where);
    collectNestedSelects(node.groupby);
    collectNestedSelects(node.having);
    collectNestedSelects(node.orderby);
  };

  const collectNestedSelects = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectNestedSelects(item));
      return;
    }
    if (!isSqlAstRecord(value) || visitedExpressions.has(value)) return;
    visitedExpressions.add(value);

    if (isSelectStatement(value)) collectFromStatement(value);
    if (value.ast) collectNestedSelects(value.ast);
    if (value.stmt) collectNestedSelects(value.stmt);

    Object.entries(value).forEach(([key, child]) => {
      if (["as", "ast", "column", "db", "stmt", "table"].includes(key)) return;
      collectNestedSelects(child);
    });
  };

  collectFromStatement(statement);
  return cteNames;
}

function extractReferencedTableNames(statement: SqlAstNode) {
  const tableNames = new Set<string>();
  const visitedExpressions = new WeakSet<object>();
  const visitedStatements = new WeakSet<object>();

  const collectFromStatement = (node: unknown) => {
    if (!isSqlAstRecord(node) || visitedStatements.has(node)) return;
    visitedStatements.add(node);

    node.from?.forEach((fromItem) => {
      collectFromItem(fromItem);
    });
    node.with?.forEach((cte) => {
      collectNestedSelects(cte);
    });
    collectNestedSelects(node.columns);
    collectNestedSelects(node.where);
    collectNestedSelects(node.groupby);
    collectNestedSelects(node.having);
    collectNestedSelects(node.orderby);
    collectNestedSelects(node.window);
  };

  const collectFromItem = (fromItem: unknown) => {
    if (!isSqlAstRecord(fromItem)) return;
    if (fromItem.table) {
      const qualifiedName = fromItem.db ? `${fromItem.db}.${fromItem.table}` : fromItem.table;
      tableNames.add(normalizeSqlIdentifier(qualifiedName));
    }
    collectNestedSelects(fromItem.expr);
    collectNestedSelects(fromItem.on);
    collectNestedSelects(fromItem.using);
  };

  const collectNestedSelects = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectNestedSelects(item));
      return;
    }
    if (!isSqlAstRecord(value) || visitedExpressions.has(value)) return;
    visitedExpressions.add(value);

    if (isSelectStatement(value)) {
      collectFromStatement(value);
    }
    if (value.ast) collectNestedSelects(value.ast);
    if (value.stmt) collectNestedSelects(value.stmt);

    Object.entries(value).forEach(([key, child]) => {
      if (["as", "ast", "column", "db", "stmt", "table"].includes(key)) return;
      if (key === "from" && Array.isArray(child)) {
        child.forEach((fromItem) => collectFromItem(fromItem));
        return;
      }
      collectNestedSelects(child);
    });
  };

  collectFromStatement(statement);
  return Array.from(tableNames);
}

function isSqlAstRecord(value: unknown): value is SqlAstNode {
  return typeof value === "object" && value !== null;
}

function extractTableAliases(statement: SqlAstNode) {
  const aliases = new Set<string>();
  const visitedExpressions = new WeakSet<object>();
  const visitedStatements = new WeakSet<object>();

  const collectFromStatement = (node: unknown) => {
    if (!isSqlAstRecord(node) || visitedStatements.has(node)) return;
    visitedStatements.add(node);

    node.from?.forEach((fromItem) => {
      if (fromItem.as) aliases.add(fromItem.as);
      collectNestedSelects(fromItem.expr);
      collectNestedSelects(fromItem.on);
    });
    node.with?.forEach((cte) => {
      if (cte.stmt) collectFromStatement(cte.stmt);
    });
    collectNestedSelects(node.columns);
    collectNestedSelects(node.where);
    collectNestedSelects(node.groupby);
    collectNestedSelects(node.having);
    collectNestedSelects(node.orderby);
  };

  const collectNestedSelects = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectNestedSelects(item));
      return;
    }
    if (!isSqlAstRecord(value) || visitedExpressions.has(value)) return;
    visitedExpressions.add(value);

    if (isSelectStatement(value)) collectFromStatement(value);
    if (value.ast) collectNestedSelects(value.ast);
    if (value.stmt) collectNestedSelects(value.stmt);

    Object.entries(value).forEach(([key, child]) => {
      if (["as", "ast", "column", "db", "stmt", "table"].includes(key)) return;
      collectNestedSelects(child);
    });
  };

  collectFromStatement(statement);
  return Array.from(aliases);
}

const SQL_AUTOCOMPLETE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
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
  return {
    token,
    start,
    end,
    mode,
    key: `${start}:${end}:${mode}:${token}`,
  };
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

export function escapeCsvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatResultTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "executed";

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
