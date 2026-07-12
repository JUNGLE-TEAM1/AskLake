import postgresqlParser from "node-sql-parser/build/postgresql.js";
import { normalizeSqlIdentifier } from "./sqlIdentifiers";

const { Parser: SqlParser } = postgresqlParser;
const sqlParser = new SqlParser();

export type SqlAstNode = {
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

export function parseSqlQuery(query: string): { ast: SqlAstNode | SqlAstNode[]; ok: true } | { message: string; ok: false } {
  try {
    return { ast: sqlParser.astify(query, { database: "postgresql" }) as SqlAstNode | SqlAstNode[], ok: true };
  } catch (error) {
    return { message: `SQL 문법 오류입니다. ${getParserErrorHint(error)}`, ok: false };
  }
}

function getParserErrorHint(error: unknown) {
  if (isParserSyntaxError(error)) {
    const found = error.found ? ` "${error.found}"` : "";
    return `${error.location.start.line}:${error.location.start.column} 위치의${found} 토큰을 확인해 주세요.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("but") && message.includes("found")) return message.replace(/\s+/g, " ");
  return "문장을 확인해 주세요.";
}

function isParserSyntaxError(error: unknown): error is { found?: string; location: { start: { column: number; line: number } } } {
  return typeof error === "object"
    && error !== null
    && "location" in error
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.line === "number"
    && typeof (error as { location?: { start?: { column?: unknown; line?: unknown } } }).location?.start?.column === "number";
}

export function isSelectStatement(statement: SqlAstNode) {
  return statement.type === "select";
}

export function findLimitIssue(statement: SqlAstNode) {
  const limitValues = statement.limit?.value ?? [];
  const invalidLimit = limitValues.find((item) => item.type !== "number" || !Number.isFinite(Number(item.value)));
  return invalidLimit ? "LIMIT에는 숫자만 입력할 수 있습니다." : null;
}

export function extractCteNames(statement: SqlAstNode) {
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

export function extractReferencedTableNames(statement: SqlAstNode) {
  const tableNames = new Set<string>();
  const visitedExpressions = new WeakSet<object>();
  const visitedStatements = new WeakSet<object>();

  const collectFromStatement = (node: unknown) => {
    if (!isSqlAstRecord(node) || visitedStatements.has(node)) return;
    visitedStatements.add(node);
    node.from?.forEach((fromItem) => collectFromItem(fromItem));
    node.with?.forEach((cte) => collectNestedSelects(cte));
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
    if (isSelectStatement(value)) collectFromStatement(value);
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

export function extractTableAliases(statement: SqlAstNode) {
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

function isSqlAstRecord(value: unknown): value is SqlAstNode {
  return typeof value === "object" && value !== null;
}
