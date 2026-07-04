export function parseSourceSample(name, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { columns: [], format: "empty", rows: [] };
  const lowerName = String(name ?? "").toLowerCase();

  if (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonSample(trimmed, lowerName.endsWith(".jsonl") ? "jsonl" : "json");
  }

  if (lowerName.endsWith(".txt")) {
    return parseTextSample(trimmed);
  }

  return parseDelimitedSample(trimmed, lowerName.endsWith(".tsv") ? "\t" : ",");
}

export function inferSchemaColumns(sample) {
  return sample.columns.map((column, index) => {
    const values = sample.rows.map((row) => String(row[index] ?? ""));
    return {
      confidence: values.length > 0 ? 90 : 65,
      nullable: values.some((value) => value.trim() === ""),
      role: inferRole(column),
      sourceName: column,
      targetName: normalizeColumnName(column),
      type: inferType(values),
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
    .replace(/[^0-9A-Za-z_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function parseDelimitedSample(text, delimiter) {
  const rows = text.split(/\r?\n/).slice(0, 51).map((line) => parseDelimitedLine(line, delimiter));
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1, 11);
  return {
    columns: header.map((column, index) => column.trim() || `column_${index + 1}`),
    format: delimiter === "\t" ? "tsv" : "csv",
    rows: dataRows,
  };
}

function parseTextSample(text) {
  const rows = text.split(/\r?\n/).slice(0, 10).map((line, index) => [String(index + 1), line]);
  return {
    columns: ["line_number", "value"],
    format: "txt",
    rows,
  };
}

function parseJsonSample(text, format) {
  const values = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) values.push(...parsed.slice(0, 10));
    else values.push(parsed);
  } catch {
    for (const line of text.split(/\r?\n/).slice(0, 10)) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        break;
      }
    }
    format = "jsonl";
  }

  const flattened = values.map((value) => flattenRecord(value));
  const columns = Array.from(new Set(flattened.flatMap((record) => Object.keys(record))));
  return {
    columns,
    format,
    rows: flattened.map((record) => columns.map((column) => stringifyCell(record[column]))),
  };
}

function inferType(values) {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "String";
  if (nonEmpty.every((value) => /^-?\d+$/.test(value))) return "Integer";
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Float";
  if (nonEmpty.every((value) => !Number.isNaN(Date.parse(value)) && /[-:TZ/]/.test(value))) return "Timestamp";
  if (nonEmpty.every((value) => ["true", "false"].includes(value.toLowerCase()))) return "Boolean";
  if (nonEmpty.every((value) => (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) return "JSON";
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
