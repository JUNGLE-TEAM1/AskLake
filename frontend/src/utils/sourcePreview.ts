export function extractRawTextPreviewLines(
  columnLabels: string[],
  rows: string[][],
): string[] {
  const valueIndex = columnLabels.findIndex((column) => /^(value|raw_value)$/i.test(column.trim()));
  if (valueIndex < 0) return [];

  return rows
    .map((row) => row[valueIndex] ?? "")
    .filter((line) => line.trim().length > 0);
}

const CLICK_LOG_RAW_FIELDS = [
  "raw.event_time",
  "raw.event_id",
  "raw.user_id",
  "raw.session_id",
  "raw.event_type",
  "raw.product_id",
  "raw.page_url",
  "raw.device_type",
  "raw.referrer",
  "raw.position",
] as const;

export function extractKafkaClickLogPreviewLines(
  columnLabels: string[],
  rows: string[][],
): string[] {
  const columnIndexes = new Map(columnLabels.map((column, index) => [column.trim().toLowerCase(), index]));
  const sourceIndex = columnIndexes.get("source");
  const rawIndexes = CLICK_LOG_RAW_FIELDS.map((field) => columnIndexes.get(field));
  if (sourceIndex === undefined || rawIndexes.some((index) => index === undefined)) return [];

  const nonEmptyRows = rows.filter((row) => row.some((value) => value.trim().length > 0));
  if (nonEmptyRows.length === 0 || nonEmptyRows.some((row) => row[sourceIndex] !== "click-events-log")) return [];

  return nonEmptyRows.map((row) => rawIndexes
    .map((index) => row[index as number] ?? "")
    .join(" "));
}

export function shouldShowRawTextPreview({
  detectedFormat,
  requiresRecordParsing,
  rawLines,
  sourceType,
}: {
  detectedFormat?: string;
  requiresRecordParsing?: boolean;
  rawLines: string[];
  sourceType: string;
}): boolean {
  return sourceType === "File / S3"
    && detectedFormat?.toUpperCase() === "TXT"
    && requiresRecordParsing === true
    && rawLines.length > 0;
}

export function shouldShowKafkaClickLogPreview({
  rawLines,
  sourceType,
}: {
  rawLines: string[];
  sourceType: string;
}): boolean {
  return sourceType === "Stream / Kafka" && rawLines.length > 0;
}
