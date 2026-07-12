export function parseSourceSample(name, text, options = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { columns: [], format: "empty", rows: [] };
  const lowerName = String(name ?? "").toLowerCase();
  const maxRows = normalizeMaxRows(options.maxRows);

  if (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonSample(trimmed, lowerName.endsWith(".jsonl") ? "jsonl" : "json", maxRows);
  }

  if (lowerName.endsWith(".txt")) {
    return parseTextSample(trimmed, maxRows);
  }

  return parseDelimitedSample(trimmed, lowerName.endsWith(".tsv") ? "\t" : ",", maxRows);
}

export function inferSchemaColumns(sample) {
  return sample.columns.map((column, index) => {
    const values = sample.rows.map((row) => String(row[index] ?? ""));
    const nativeValues = Array.isArray(sample.nativeRows)
      ? sample.nativeRows.map((row) => row[index])
      : null;
    return {
      confidence: values.length > 0 ? 90 : 65,
      nullable: nativeValues
        ? nativeValues.some((value) => value === null || value === undefined || (typeof value === "string" && value.trim() === ""))
        : values.some((value) => value.trim() === ""),
      role: inferRole(column),
      sourceName: column,
      targetName: normalizeColumnName(column),
      type: nativeValues ? inferNativeType(nativeValues) : inferType(values),
    };
  });
}

export function canonicalSchemaType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/json|array|struct|map|object/.test(normalized)) return "JSON";
  if (/bool/.test(normalized)) return "Boolean";
  if (/timestamp|datetime/.test(normalized)) return "Timestamp";
  if (normalized === "date") return "Date";
  if (/bigint|int64|\blong\b/.test(normalized)) return "Long";
  if (/smallint|tinyint|int32|integer|\bint\b/.test(normalized)) return "Integer";
  if (/float|double|decimal|numeric|number|real/.test(normalized)) return "Double";
  return "String";
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
    .replace(/[^0-9A-Za-z_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function parseDelimitedSample(text, delimiter, maxRows) {
  const rows = text.split(/\r?\n/).slice(0, maxRows + 1).map((line) => parseDelimitedLine(line, delimiter));
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1, maxRows + 1);
  return {
    columns: header.map((column, index) => column.trim() || `column_${index + 1}`),
    format: delimiter === "\t" ? "tsv" : "csv",
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
  const nativeRows = flattened.map((record) => columns.map((column) => record[column]));
  return {
    columns,
    format,
    nativeRows,
    rows: nativeRows.map((row) => row.map(stringifyCell)),
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
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Double";
  if (nonEmpty.every((value) => !Number.isNaN(Date.parse(value)) && /[-:TZ/]/.test(value))) return "Timestamp";
  if (nonEmpty.every((value) => ["true", "false"].includes(value.toLowerCase()))) return "Boolean";
  if (nonEmpty.every((value) => (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) return "JSON";
  return "String";
}

function inferNativeType(values) {
  const nonNull = values.filter((value) => value !== null && value !== undefined);
  if (nonNull.length === 0) return "String";
  const types = new Set(nonNull.map((value) => {
    if (typeof value === "string") return "String";
    if (typeof value === "boolean") return "Boolean";
    if (typeof value === "number") return Number.isInteger(value) ? "Long" : "Double";
    if (typeof value === "object") return "JSON";
    return "String";
  }));
  if (types.size === 1) return types.values().next().value;
  if (types.size === 2 && types.has("Long") && types.has("Double")) return "Double";
  return "String";
}

function inferRole(column) {
  const normalized = normalizeColumnName(column);
  if (normalized === "id" || normalized.endsWith("_id")) return "Identifier";
  if (normalized.includes("email")) return "PII";
  if (normalized.includes("time") || normalized.includes("date") || normalized.endsWith("_ts")) return "Event Time";
  if (normalized.includes("price") || normalized.includes("amount") || normalized.includes("rating")) return "Metric";
  return undefined;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
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
