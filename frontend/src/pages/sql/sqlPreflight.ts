import type { CatalogDataset } from "../../types";
import {
  extractCteNames,
  extractReferencedTableNames,
  extractTableAliases,
  findLimitIssue,
  isSelectStatement,
  parseSqlQuery,
} from "./sqlAst";
import {
  getDatasetSqlReference,
  needsQuotedIdentifier,
  normalizeSqlIdentifier,
} from "./sqlIdentifiers";

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

export function getPreflightSummary(result: SqlPreflightResult | null) {
  if (!result) return null;
  if (result.canExecute) {
    const warningMessage = result.messages.find((message) => message.tone === "warning")?.text;
    if (warningMessage) return { detail: warningMessage, label: "확인 필요", tone: "warning" as const };
    return { detail: "", label: "점검 통과", tone: "success" as const };
  }
  const errorMessage = result.messages.find((message) => message.tone === "error")?.text ?? "SQL을 확인해 주세요.";
  return { detail: errorMessage, label: "점검 필요", tone: "error" as const };
}

export function runSqlPreflight(
  query: string,
  baseDataset: CatalogDataset,
  referenceDatasets: CatalogDataset[],
  key: string,
  previewRowLimit = PREVIEW_ROW_LIMIT,
): SqlPreflightResult {
  const normalizedQuery = stripSqlComments(query).trim();
  const messages: SqlPreflightMessage[] = [];
  const contextDatasets = [baseDataset, ...referenceDatasets];
  if (!normalizedQuery) {
    return { key, canExecute: false, messages: [{ tone: "error", text: "실행할 SQL을 입력해 주세요." }] };
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
    return { key, canExecute: false, messages: [{ tone: "error", text: parsedQuery.message }] };
  }

  const statements = Array.isArray(parsedQuery.ast) ? parsedQuery.ast : [parsedQuery.ast];
  if (statements.length !== 1) {
    return { key, canExecute: false, messages: [{ tone: "error", text: "실행은 단일 SELECT 문만 허용합니다." }] };
  }
  const statement = statements[0];
  if (!isSelectStatement(statement)) {
    return { key, canExecute: false, messages: [{ tone: "error", text: "읽기 전용 SQL만 실행할 수 있습니다. SELECT 또는 WITH로 시작해야 합니다." }] };
  }
  const limitIssue = findLimitIssue(statement);
  if (limitIssue) return { key, canExecute: false, messages: [{ tone: "error", text: limitIssue }] };

  const allowedTableNames = new Set(
    contextDatasets.flatMap((item) => [item.name, item.id]).map(normalizeSqlIdentifier),
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
  messages.push({ tone: "info", text: `전체 쿼리 결과를 저장하고 화면에는 ${previewRowLimit}행씩 나누어 표시합니다.` });
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
  const matcher = new RegExp(`\\b(from|join)\\s+(${escapeRegExp(tableName)})(?=\\s|;|$)`, "gi");
  return query.replace(matcher, (_match, keyword: string) => `${keyword} ${quotedTableName}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSqlComments(query: string) {
  return query.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function findAmbiguousUnqualifiedSelectColumns(query: string, datasets: CatalogDataset[]) {
  if (datasets.length <= 1) return [];
  const match = query.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
  if (!match) return [];

  const columnCounts = new Map<string, number>();
  datasets.forEach((dataset) => {
    const datasetColumnNames = new Set(dataset.schema.map(([name]) => name.trim().toLowerCase()));
    datasetColumnNames.forEach((columnName) => {
      columnCounts.set(columnName, (columnCounts.get(columnName) ?? 0) + 1);
    });
  });

  return Array.from(new Set(
    match[1]
      .split(",")
      .map((part) => part.trim())
      .map((part) => part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)$/)?.[1] ?? "")
      .filter((columnName) => columnName && (columnCounts.get(columnName.trim().toLowerCase()) ?? 0) > 1),
  ));
}
