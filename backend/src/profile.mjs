export function parseSourceSample(name, text, options = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { columns: [], format: "empty", rows: [] };
  const lowerName = String(name ?? "").toLowerCase();
  const maxRows = normalizeMaxRows(options.maxRows);
  const parserMode = normalizeParserMode(options.parserMode);

  if (parserMode !== "delimited" && (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl") || trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return parseJsonSample(trimmed, lowerName.endsWith(".jsonl") ? "jsonl" : "json", maxRows);
  }

  const hasExplicitDialect = normalizeDelimiter(options.delimiter, "") !== "";
  const hasCustomFields = normalizeDelimitedFields(options.fields).length > 0;
  if (parserMode === "raw" || (lowerName.endsWith(".txt") && parserMode === "auto" && !hasExplicitDialect && !hasCustomFields)) {
    return parseTextSample(trimmed, maxRows);
  }

  return parseDelimitedSample(trimmed, {
    delimiter: options.delimiter,
    escapeChar: options.escapeChar,
    fields: options.fields,
    hasHeader: options.hasHeader,
    maxRows,
    name: lowerName,
    quoteChar: options.quoteChar,
    rowDelimiter: options.rowDelimiter,
  });
}

export function inferSchemaColumns(sample) {
  return sample.columns.map((column, index) => {
    const values = sample.rows.map((row) => String(row[index] ?? ""));
    const declaredField = sample.fields?.[index];
    return {
      confidence: declaredField ? 100 : values.length > 0 ? 90 : 65,
      nullable: declaredField?.nullable ?? values.some((value) => value.trim() === ""),
      role: inferRole(column),
      sourceName: column,
      targetName: normalizeColumnName(column),
      type: declaredField?.type || inferType(values),
    };
  });
}

export function schemaFingerprint(columns) {
  return columns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|");
}

export function sourceId(prefix, value) {
  return stableId(prefix, value);
}

export function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fieldValue(fields, label) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

export function upsertFields(fields, updates) {
  const updateMap = new Map(updates);
  const seen = new Set();
  const merged = fields.map(([label, value]) => {
    seen.add(label);
    return [label, updateMap.get(label) ?? value];
  });
  for (const [label, value] of updates) {
    if (!seen.has(label)) merged.push([label, value]);
  }
  return merged;
}

export function normalizeColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function parseDelimitedSample(text, options) {
  const rowSplit = splitDelimitedRows(text, options.rowDelimiter);
  const lines = rowSplit.rows.filter((line) => line.length > 0);
  const fallbackDelimiter = options.name.endsWith(".tsv") ? "\t" : ",";
  const explicitDelimiter = normalizeDelimiter(options.delimiter, "");
  const delimiter = explicitDelimiter || detectDelimiter(lines, fallbackDelimiter, options.quoteChar, options.escapeChar);
  const quoteChar = normalizeSingleCharacter(options.quoteChar, '"', "");
  const escapeChar = normalizeSingleCharacter(options.escapeChar, "", "");
  const parsedRows = lines.slice(0, options.maxRows + 1).map((line) => parseDelimitedLine(line, delimiter, quoteChar, escapeChar));
  const fields = normalizeDelimitedFields(options.fields);
  const hasHeader = normalizeHeaderOption(options.hasHeader, parsedRows);
  const candidateRows = parsedRows.slice(hasHeader ? 1 : 0, options.maxRows + (hasHeader ? 1 : 0));
  const inferredWidth = Math.max(0, ...parsedRows.map((row) => row.length));
  const columns = fields.length > 0
    ? fields.map((field) => field.name)
    : hasHeader
      ? uniqueColumnNames(parsedRows[0] ?? [])
      : Array.from({ length: inferredWidth }, (_, index) => `column_${index + 1}`);
  const expectedWidth = columns.length;
  const widthConflicts = candidateRows.filter((row) => row.length !== expectedWidth).length;
  const overflowRows = candidateRows.filter((row) => row.length > expectedWidth).length;
  if (fields.length > 0 && overflowRows > 0) {
    const error = new Error(`Delimited sample contains ${overflowRows} row(s) wider than the ${expectedWidth} configured fields.`);
    error.code = "DELIMITED_FIELD_COUNT_MISMATCH";
    error.status = 400;
    throw error;
  }
  const dataRows = candidateRows.map((row) => columns.map((_, index) => row[index] ?? ""));
  const format = options.name.endsWith(".tsv") || delimiter === "\t" ? "tsv" : "csv";
  return {
    columns,
    fields: fields.length > 0 ? fields : undefined,
    format,
    profile: {
      detected: {
        delimiter,
        doublequote: true,
        escapechar: escapeChar || null,
        has_header: hasHeader,
        line_separator: rowSplit.delimiter,
        quotechar: quoteChar || null,
      },
      overflow_rows: overflowRows,
      parsed_rows: dataRows.length,
      sample_bytes: Buffer.byteLength(text, "utf8"),
      spark_options: {
        header: hasHeader,
        lineSep: rowSplit.delimiter,
        mode: "PERMISSIVE",
        multiLine: false,
      },
      status: "profiled",
      width_conflicts: widthConflicts,
    },
    rows: dataRows,
  };
}

function parseTextSample(text, maxRows) {
  const rows = text.split(/\r?\n/).slice(0, maxRows).map((line, index) => [String(index + 1), line]);
  return {
    columns: ["line_number", "value"],
    format: "txt",
    rows,
  };
}

function parseJsonSample(text, format, maxRows) {
  const values = [];
  if (format === "jsonl") {
    values.push(...parseJsonLines(text, maxRows));
    return jsonValuesToSample(values, format);
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) values.push(...parsed.slice(0, maxRows));
    else values.push(parsed);
  } catch {
    values.push(...parseJsonLines(text, maxRows));
    if (values.length === 0) {
      values.push(...parseJsonArrayPrefix(text, maxRows));
    }
    format = "jsonl";
  }

  return jsonValuesToSample(values, format);
}

function parseJsonLines(text, maxRows) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    if (values.length >= maxRows) break;
    const trimmed = line.trim().replace(/,$/, "");
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return values;
}

function parseJsonArrayPrefix(text, maxRows) {
  const values = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char !== "}") continue;

    depth -= 1;
    if (depth === 0 && objectStart >= 0) {
      const candidate = text.slice(objectStart, index + 1);
      try {
        values.push(JSON.parse(candidate));
      } catch {
        // Ignore incomplete object fragments from bounded reads.
      }
      objectStart = -1;
      if (values.length >= maxRows) break;
    }
  }
  return values;
}

function jsonValuesToSample(values, format) {
  const flattened = values.map((value) => flattenRecord(value));
  const columns = Array.from(new Set(flattened.flatMap((record) => Object.keys(record))));
  return {
    columns,
    format,
    rows: flattened.map((record) => columns.map((column) => stringifyCell(record[column]))),
  };
}

function normalizeMaxRows(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.trunc(parsed), 1), 50000);
}

function inferType(values) {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "String";
  if (nonEmpty.every((value) => /^-?\d+$/.test(value))) return "Integer";
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Float";
  if (nonEmpty.every(isTimestampValue)) return "Timestamp";
  if (nonEmpty.every((value) => ["true", "false"].includes(value.toLowerCase()))) return "Boolean";
  if (nonEmpty.every((value) => (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) return "JSON";
  return "String";
}

function isTimestampValue(value) {
  const timestampPattern = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  return timestampPattern.test(value) && !Number.isNaN(Date.parse(value));
}

function inferRole(column) {
  const normalized = normalizeColumnName(column);
  if (normalized === "id" || normalized.endsWith("_id")) return "Identifier";
  if (normalized.includes("email")) return "PII";
  if (normalized.includes("time") || normalized.includes("date") || normalized.endsWith("_ts")) return "Event Time";
  if (normalized.includes("price") || normalized.includes("amount") || normalized.includes("rating")) return "Metric";
  return undefined;
}

function parseDelimitedLine(line, delimiter, quoteChar = '"', escapeChar = "") {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (escapeChar && char === escapeChar && next !== undefined) {
      cell += next;
      index += 1;
    } else if (quoteChar && char === quoteChar && next === quoteChar) {
      cell += quoteChar;
      index += 1;
    } else if (quoteChar && char === quoteChar) {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function detectDelimiter(lines, fallbackDelimiter, quoteChar, escapeChar) {
  const candidates = [",", "\t", "|", ";"];
  const scored = candidates.map((delimiter) => {
    const widths = lines.slice(0, 25).map((line) => parseDelimitedLine(
      line,
      delimiter,
      normalizeSingleCharacter(quoteChar, '"', ""),
      normalizeSingleCharacter(escapeChar, "", ""),
    ).length);
    const counts = widths.reduce((map, width) => map.set(width, (map.get(width) || 0) + 1), new Map());
    const [modeWidth, modeCount] = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0] || [1, 0];
    const conflicts = widths.length - modeCount;
    return { delimiter, score: modeWidth > 1 ? modeWidth * modeCount - conflicts * 2 : 0 };
  }).sort((left, right) => right.score - left.score);
  return scored[0]?.score > 0 ? scored[0].delimiter : fallbackDelimiter;
}

function normalizeDelimiter(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "auto") return fallback;
  const aliases = new Map([
    ["\\t", "\t"],
    ["tab", "\t"],
    ["comma", ","],
    ["pipe", "|"],
    ["semicolon", ";"],
    ["space", " "],
  ]);
  const decoded = aliases.get(raw.toLowerCase()) ?? raw;
  if (Array.from(decoded).length !== 1) {
    const error = new Error("Delimiter must be one character or one of: auto, comma, tab, pipe, semicolon, space.");
    error.code = "INVALID_DELIMITER";
    error.status = 400;
    throw error;
  }
  return decoded;
}

function splitDelimitedRows(text, value) {
  const configured = normalizeRowDelimiter(value);
  const delimiter = configured
    || (text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n");
  return { delimiter, rows: String(text).split(delimiter) };
}

function normalizeRowDelimiter(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "auto") return "";
  const aliases = new Map([
    ["\\n", "\n"],
    ["lf", "\n"],
    ["newline", "\n"],
    ["\\r", "\r"],
    ["cr", "\r"],
    ["\\r\\n", "\r\n"],
    ["crlf", "\r\n"],
  ]);
  const decoded = aliases.get(raw.toLowerCase());
  if (!decoded) {
    const error = new Error("Row delimiter must be auto, \\n, \\r, or \\r\\n.");
    error.code = "INVALID_ROW_DELIMITER";
    error.status = 400;
    throw error;
  }
  return decoded;
}

function normalizeSingleCharacter(value, fallback, noneValue = fallback) {
  const raw = String(value ?? "");
  if (!raw) return fallback;
  if (raw.toLowerCase() === "none") return noneValue;
  const decoded = raw === "\\t" ? "\t" : raw === "\\\\" ? "\\" : raw;
  if (Array.from(decoded).length !== 1) {
    const error = new Error("Quote and escape values must be one character or none.");
    error.code = "INVALID_DELIMITED_DIALECT_CHARACTER";
    error.status = 400;
    throw error;
  }
  return decoded;
}

function normalizeHeaderOption(value, rows) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (["true", "yes", "1", "header", "treat first row as header"].includes(normalized)) return true;
  if (["false", "no", "0", "none", "no header"].includes(normalized)) return false;
  return detectHeader(rows);
}

function detectHeader(rows) {
  const first = rows[0] ?? [];
  const second = rows[1] ?? [];
  if (first.length === 0 || second.length === 0 || new Set(first).size !== first.length) return false;
  const firstLooksNamed = first.every((value) => value.trim() !== "" && inferType([value]) === "String");
  const secondHasTypedValue = second.some((value) => inferType([value]) !== "String");
  return firstLooksNamed && secondHasTypedValue;
}

function normalizeDelimitedFields(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "[]");
    } catch {
      const error = new Error("Delimited field definitions must be valid JSON.");
      error.code = "INVALID_DELIMITED_FIELDS";
      error.status = 400;
      throw error;
    }
  }
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > 200) {
    const error = new Error("Delimited field definitions are limited to 200 fields.");
    error.code = "TOO_MANY_DELIMITED_FIELDS";
    error.status = 400;
    throw error;
  }
  const fields = parsed.map((field, index) => ({
    name: String(field?.name || `column_${index + 1}`).trim(),
    nullable: field?.nullable !== false,
    type: normalizeDeclaredType(field?.type),
  }));
  const normalizedNames = fields.map((field) => normalizeColumnName(field.name));
  if (fields.some((field) => !field.name) || new Set(normalizedNames).size !== normalizedNames.length) {
    const error = new Error("Delimited field names must be non-empty and unique after normalization.");
    error.code = "INVALID_DELIMITED_FIELD_NAMES";
    error.status = 400;
    throw error;
  }
  return fields;
}

function normalizeDeclaredType(value) {
  const normalized = String(value || "String").trim().toLowerCase();
  if (["integer", "int", "long", "bigint"].includes(normalized)) return normalized === "long" || normalized === "bigint" ? "Long" : "Integer";
  if (["float", "double", "decimal", "number"].includes(normalized)) return normalized === "float" ? "Float" : "Double";
  if (["boolean", "bool"].includes(normalized)) return "Boolean";
  if (["timestamp", "datetime"].includes(normalized)) return "Timestamp";
  if (normalized === "date") return "Date";
  return "String";
}

function uniqueColumnNames(values) {
  const used = new Set();
  return values.map((value, index) => {
    const base = String(value ?? "").trim() || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(normalizeColumnName(candidate))) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(normalizeColumnName(candidate));
    return candidate;
  });
}

function normalizeParserMode(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["delimited", "csv", "structured"].includes(normalized)) return "delimited";
  if (["raw", "text", "line"].includes(normalized)) return "raw";
  return "auto";
}

function flattenRecord(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix || "value"]: value };
  }
  return Object.entries(value).reduce((acc, [key, child]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(acc, flattenRecord(child, nextKey));
    } else {
      acc[nextKey] = child;
    }
    return acc;
  }, {});
}

function stableId(prefix, value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${Math.abs(hash).toString(16)}`;
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
