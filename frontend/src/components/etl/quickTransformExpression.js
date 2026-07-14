const QUICK_TRANSFORM_NAMES = [
  "UPPER",
  "LOWER",
  "TRIM",
  "REPLACE",
  "SUBSTR",
  "CONCAT",
  "CAST",
  "COALESCE",
  "ROUND",
  "ABS",
];

const SQL_TYPES = {
  boolean: "BOOLEAN",
  date: "DATE",
  double: "DOUBLE",
  integer: "INT",
  json: "STRING",
  long: "BIGINT",
  string: "STRING",
  timestamp: "TIMESTAMP",
};

export function applyQuickTransformExpression({
  expression,
  name,
  outputType,
  sourceExpression,
}) {
  const current = String(expression || "").trim() || sourceExpression;
  const source = sourceExpression || current;

  switch (name) {
    case "UPPER":
      return `UPPER(CAST(${current} AS STRING))`;
    case "LOWER":
      return `LOWER(CAST(${current} AS STRING))`;
    case "TRIM":
      return `TRIM(CAST(${current} AS STRING))`;
    case "REPLACE":
      return `REPLACE(CAST(${current} AS STRING), '', '')`;
    case "SUBSTR":
      return `SUBSTR(CAST(${current} AS STRING), 1, 10)`;
    case "CONCAT":
      return `CONCAT(CAST(${current} AS STRING), '-', CAST(${source} AS STRING))`;
    case "CAST":
      return `CAST(${current} AS ${SQL_TYPES[String(outputType || "string").toLowerCase()] || "STRING"})`;
    case "COALESCE":
      return `COALESCE(${current}, 'default')`;
    case "ROUND":
      return `ROUND(CAST(${current} AS DOUBLE), 2)`;
    case "ABS":
      return `ABS(CAST(${current} AS DOUBLE))`;
    default:
      return current;
  }
}

export function toggleQuickTransformExpression({
  expression,
  name,
  outputType,
  sourceExpression,
}) {
  const current = String(expression || "").trim() || sourceExpression;
  if (detectQuickTransformFunctions(current).includes(name)) {
    return removeQuickTransform(current, name);
  }
  return applyQuickTransformExpression({
    expression: current,
    name,
    outputType,
    sourceExpression,
  });
}

export function detectQuickTransformFunctions(expression) {
  const selected = new Set();
  let current = String(expression || "").trim();

  while (current) {
    const call = parseOuterCall(current);
    if (!call || !QUICK_TRANSFORM_NAMES.includes(call.name)) break;

    selected.add(call.name);
    current = quickTransformInput(call);
  }

  return QUICK_TRANSFORM_NAMES.filter((name) => selected.has(name));
}

function quickTransformInput(call) {
  const firstArgument = call.arguments[0] || "";

  switch (call.name) {
    case "UPPER":
    case "LOWER":
    case "TRIM":
    case "REPLACE":
    case "SUBSTR":
    case "CONCAT":
      return unwrapCastInput(firstArgument);
    case "ROUND":
    case "ABS":
      return unwrapCastInput(firstArgument);
    case "CAST":
      return castInput(call.body);
    case "COALESCE":
      return firstArgument;
    default:
      return "";
  }
}

function removeQuickTransform(expression, targetName) {
  const call = parseOuterCall(expression);
  if (!call || !QUICK_TRANSFORM_NAMES.includes(call.name)) return expression.trim();

  const nextInput = removeQuickTransform(quickTransformInput(call), targetName);
  if (call.name === targetName) return nextInput;
  return rebuildQuickTransformCall(call, nextInput);
}

function rebuildQuickTransformCall(call, input) {
  const rest = call.arguments.slice(1);
  const trailingArguments = rest.length ? `, ${rest.join(", ")}` : "";

  switch (call.name) {
    case "UPPER":
    case "LOWER":
    case "TRIM":
      return `${call.name}(CAST(${input} AS STRING))`;
    case "REPLACE":
    case "SUBSTR":
    case "CONCAT":
      return `${call.name}(CAST(${input} AS STRING)${trailingArguments})`;
    case "ROUND":
      return `ROUND(CAST(${input} AS DOUBLE)${trailingArguments})`;
    case "ABS":
      return `ABS(CAST(${input} AS DOUBLE))`;
    case "CAST":
      return `CAST(${input} AS ${castType(call.body)})`;
    case "COALESCE":
      return `COALESCE(${input}${trailingArguments})`;
    default:
      return input;
  }
}

function parseOuterCall(expression) {
  const source = expression.trim();
  const match = source.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!match) return null;

  const openIndex = source.indexOf("(", match[0].length - 1);
  const closeIndex = matchingParenthesis(source, openIndex);
  if (closeIndex !== source.length - 1) return null;

  const body = source.slice(openIndex + 1, closeIndex);
  return {
    arguments: splitTopLevelArguments(body),
    body,
    name: match[1].toUpperCase(),
  };
}

function unwrapCastInput(expression) {
  const call = parseOuterCall(expression);
  if (call?.name !== "CAST") return expression.trim();
  return castInput(call.body);
}

function castInput(body) {
  const asIndex = findTopLevelKeyword(body, "AS");
  return (asIndex < 0 ? body : body.slice(0, asIndex)).trim();
}

function castType(body) {
  const asIndex = findTopLevelKeyword(body, "AS");
  return (asIndex < 0 ? "STRING" : body.slice(asIndex + 2)).trim() || "STRING";
}

function splitTopLevelArguments(body) {
  const argumentsList = [];
  let start = 0;
  let depth = 0;
  let quote = "";

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === quote && body[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      argumentsList.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }

  argumentsList.push(body.slice(start).trim());
  return argumentsList;
}

function matchingParenthesis(source, openIndex) {
  let depth = 0;
  let quote = "";

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findTopLevelKeyword(source, keyword) {
  let depth = 0;
  let quote = "";

  for (let index = 0; index <= source.length - keyword.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth !== 0) continue;

    const candidate = source.slice(index, index + keyword.length).toUpperCase();
    const before = source[index - 1] || " ";
    const after = source[index + keyword.length] || " ";
    if (candidate === keyword && /\s/.test(before) && /\s/.test(after)) return index;
  }

  return -1;
}
