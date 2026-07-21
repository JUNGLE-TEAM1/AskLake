import postgresqlParser from "node-sql-parser/build/postgresql.js";

export type SchemaPreviewExpressionResult = {
  supported: boolean;
  value: string;
};

type ExpressionValue = boolean | number | string | null;

type ExpressionNode = {
  args?: ExpressionNode[] | { type?: string; value?: ExpressionNode[] };
  column?: { expr?: { value?: string } } | string;
  cond?: ExpressionNode;
  expr?: ExpressionNode | null;
  left?: ExpressionNode;
  name?: { name?: Array<{ value?: string }> } | string;
  operator?: string;
  result?: ExpressionNode;
  right?: ExpressionNode;
  target?: Array<{ dataType?: string }>;
  type?: string;
  value?: unknown;
};

const UNSUPPORTED = Symbol("unsupported-schema-preview-expression");
const { Parser: SqlParser } = postgresqlParser;
const sqlParser = new SqlParser();
const expressionCache = new Map<string, ExpressionNode | typeof UNSUPPORTED>();

export function evaluateSchemaPreviewExpression(
  expression: string,
  row: Record<string, string>,
  fallbackValue: string,
): SchemaPreviewExpressionResult {
  const source = String(expression || "").trim();
  const ast = parseExpression(source);
  const value = ast === UNSUPPORTED ? UNSUPPORTED : evaluateExpressionNode(ast, row);
  if (value === UNSUPPORTED) {
    return { supported: false, value: fallbackValue };
  }
  return { supported: true, value: value === null ? "" : String(value) };
}

export function castSchemaPreviewValue(value: string, targetType: string) {
  const type = String(targetType || "").trim().toLowerCase();
  if (["string", "varchar", "text", "json"].includes(type)) {
    return { failed: false, value };
  }
  if (["integer", "int", "long", "bigint"].includes(type)) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? { failed: false, value: String(Math.trunc(numericValue)) }
      : { failed: true, value: "" };
  }
  if (["double", "float", "decimal", "number", "numeric"].includes(type)) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? { failed: false, value: String(numericValue) }
      : { failed: true, value: "" };
  }
  if (["boolean", "bool"].includes(type)) {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return { failed: false, value: "true" };
    if (["false", "0", "no", "n"].includes(normalized)) return { failed: false, value: "false" };
    return { failed: true, value: "" };
  }
  if (type.includes("timestamp") || type === "date") {
    const dateValue = new Date(value);
    if (Number.isNaN(dateValue.getTime())) return { failed: true, value: "" };
    return {
      failed: false,
      value: type === "date" ? dateValue.toISOString().slice(0, 10) : dateValue.toISOString(),
    };
  }
  return { failed: false, value };
}

function parseExpression(expression: string): ExpressionNode | typeof UNSUPPORTED {
  if (!expression) return { type: "single_quote_string", value: "" };
  const cached = expressionCache.get(expression);
  if (cached) return cached;
  try {
    const parserExpression = expression.replace(/\bAS\s+STRING\b/gi, "AS VARCHAR");
    const statement = sqlParser.astify(`SELECT ${parserExpression} AS __preview_value`, {
      database: "postgresql",
    }) as { columns?: Array<{ expr?: ExpressionNode }> };
    const ast = statement.columns?.[0]?.expr ?? UNSUPPORTED;
    expressionCache.set(expression, ast);
    return ast;
  } catch {
    expressionCache.set(expression, UNSUPPORTED);
    return UNSUPPORTED;
  }
}

function evaluateExpressionNode(node: ExpressionNode, row: Record<string, string>): ExpressionValue | typeof UNSUPPORTED {
  switch (node.type) {
    case "column_ref": {
      const column = typeof node.column === "string" ? node.column : node.column?.expr?.value;
      return column && Object.prototype.hasOwnProperty.call(row, column) ? row[column] ?? "" : UNSUPPORTED;
    }
    case "single_quote_string":
    case "string":
      return String(node.value ?? "");
    case "number": {
      const value = Number(node.value);
      return Number.isFinite(value) ? value : UNSUPPORTED;
    }
    case "bool":
    case "boolean":
      return node.value === true || String(node.value).toLowerCase() === "true";
    case "null":
      return null;
    case "cast": {
      if (!node.expr) return UNSUPPORTED;
      const value = evaluateExpressionNode(node.expr, row);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      const result = castSchemaPreviewValue(value === null ? "" : String(value), node.target?.[0]?.dataType ?? "");
      return result.failed ? null : result.value;
    }
    case "function":
      return evaluateFunction(node, row);
    case "binary_expr":
      return evaluateBinaryExpression(node, row);
    case "unary_expr":
      return evaluateUnaryExpression(node, row);
    case "case":
      return evaluateCaseExpression(node, row);
    case "expr":
      return node.expr ? evaluateExpressionNode(node.expr, row) : UNSUPPORTED;
    default:
      return UNSUPPORTED;
  }
}

function evaluateFunction(node: ExpressionNode, row: Record<string, string>): ExpressionValue | typeof UNSUPPORTED {
  const functionName = typeof node.name === "string"
    ? node.name
    : node.name?.name?.map((part) => part.value ?? "").join(".");
  const name = String(functionName || "").toUpperCase();
  const argumentNodes = Array.isArray(node.args) ? node.args : node.args?.value ?? [];
  const values = argumentNodes.map((argument) => evaluateExpressionNode(argument, row));
  if (values.some((value) => value === UNSUPPORTED)) return UNSUPPORTED;
  const resolved = values as ExpressionValue[];

  switch (name) {
    case "UPPER":
      return String(resolved[0] ?? "").toUpperCase();
    case "LOWER":
      return String(resolved[0] ?? "").toLowerCase();
    case "TRIM":
      return String(resolved[0] ?? "").trim();
    case "LTRIM":
      return String(resolved[0] ?? "").trimStart();
    case "RTRIM":
      return String(resolved[0] ?? "").trimEnd();
    case "REPLACE":
      return String(resolved[0] ?? "").split(String(resolved[1] ?? "")).join(String(resolved[2] ?? ""));
    case "SUBSTR": {
      const source = String(resolved[0] ?? "");
      const start = Math.max(0, Number(resolved[1] ?? 1) - 1);
      const length = Number(resolved[2]);
      return Number.isFinite(length) ? source.slice(start, start + length) : source.slice(start);
    }
    case "CONCAT":
      return resolved.map((value) => value ?? "").join("");
    case "COALESCE":
      return resolved.find((value) => value !== null) ?? null;
    case "NULLIF":
      return compareValues(resolved[0], resolved[1]) ? null : resolved[0];
    case "LENGTH":
    case "CHAR_LENGTH":
      return String(resolved[0] ?? "").length;
    case "LEFT":
      return String(resolved[0] ?? "").slice(0, Math.max(0, Number(resolved[1] ?? 0)));
    case "RIGHT": {
      const length = Math.max(0, Number(resolved[1] ?? 0));
      return length ? String(resolved[0] ?? "").slice(-length) : "";
    }
    case "ROUND": {
      const numericValue = Number(resolved[0]);
      const precision = Number(resolved[1] ?? 0);
      if (!Number.isFinite(numericValue) || !Number.isFinite(precision)) return null;
      return String(Number(numericValue.toFixed(Math.max(0, precision))));
    }
    case "ABS": {
      const numericValue = Number(resolved[0]);
      return Number.isFinite(numericValue) ? String(Math.abs(numericValue)) : null;
    }
    case "CEIL":
    case "CEILING": {
      const numericValue = Number(resolved[0]);
      return Number.isFinite(numericValue) ? Math.ceil(numericValue) : null;
    }
    case "FLOOR": {
      const numericValue = Number(resolved[0]);
      return Number.isFinite(numericValue) ? Math.floor(numericValue) : null;
    }
    default:
      return UNSUPPORTED;
  }
}

function evaluateBinaryExpression(node: ExpressionNode, row: Record<string, string>): ExpressionValue | typeof UNSUPPORTED {
  if (!node.left || !node.right) return UNSUPPORTED;
  const left = evaluateExpressionNode(node.left, row);
  const right = evaluateExpressionNode(node.right, row);
  if (left === UNSUPPORTED || right === UNSUPPORTED) return UNSUPPORTED;
  const operator = String(node.operator || "").toUpperCase();

  if (operator === "AND") return toBoolean(left) && toBoolean(right);
  if (operator === "OR") return toBoolean(left) || toBoolean(right);
  if (operator === "=") return compareValues(left, right);
  if (["!=", "<>"].includes(operator)) return !compareValues(left, right);
  if ([">", ">=", "<", "<="].includes(operator)) {
    const [leftValue, rightValue] = comparableValues(left, right);
    if (operator === ">") return leftValue > rightValue;
    if (operator === ">=") return leftValue >= rightValue;
    if (operator === "<") return leftValue < rightValue;
    return leftValue <= rightValue;
  }
  if (operator === "||") return `${left ?? ""}${right ?? ""}`;
  if (["+", "-", "*", "/", "%"].includes(operator)) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return null;
    if (operator === "+") return leftNumber + rightNumber;
    if (operator === "-") return leftNumber - rightNumber;
    if (operator === "*") return leftNumber * rightNumber;
    if (operator === "/") return rightNumber === 0 ? null : leftNumber / rightNumber;
    return rightNumber === 0 ? null : leftNumber % rightNumber;
  }
  return UNSUPPORTED;
}

function evaluateUnaryExpression(node: ExpressionNode, row: Record<string, string>): ExpressionValue | typeof UNSUPPORTED {
  if (!node.expr) return UNSUPPORTED;
  const value = evaluateExpressionNode(node.expr, row);
  if (value === UNSUPPORTED) return UNSUPPORTED;
  const operator = String(node.operator || "").toUpperCase();
  if (operator === "NOT") return !toBoolean(value);
  if (operator === "+") return Number(value);
  if (operator === "-") return -Number(value);
  return UNSUPPORTED;
}

function evaluateCaseExpression(node: ExpressionNode, row: Record<string, string>): ExpressionValue | typeof UNSUPPORTED {
  const caseValue = node.expr ? evaluateExpressionNode(node.expr, row) : null;
  if (caseValue === UNSUPPORTED) return UNSUPPORTED;
  const branches = Array.isArray(node.args) ? node.args : node.args?.value ?? [];
  for (const branch of branches) {
    if (branch.type === "else") {
      return branch.result ? evaluateExpressionNode(branch.result, row) : null;
    }
    if (branch.type !== "when" || !branch.cond) continue;
    const condition = evaluateExpressionNode(branch.cond, row);
    if (condition === UNSUPPORTED) return UNSUPPORTED;
    const matched = node.expr ? compareValues(caseValue, condition) : toBoolean(condition);
    if (matched) return branch.result ? evaluateExpressionNode(branch.result, row) : null;
  }
  return null;
}

function compareValues(left: ExpressionValue, right: ExpressionValue) {
  if (left === null || right === null) return left === right;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (String(left).trim() !== "" && String(right).trim() !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber;
  }
  return String(left) === String(right);
}

function comparableValues(left: ExpressionValue, right: ExpressionValue): [number | string, number | string] {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (String(left).trim() !== "" && String(right).trim() !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return [leftNumber, rightNumber];
  }
  return [String(left ?? ""), String(right ?? "")];
}

function toBoolean(value: ExpressionValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  return !["", "0", "false", "no", "null"].includes(value.trim().toLowerCase());
}
