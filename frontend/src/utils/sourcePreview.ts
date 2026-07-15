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

export function resolveRawTextPreviewLines({
  backendRawLines,
  columnLabels,
  rows,
}: {
  backendRawLines?: string[];
  columnLabels: string[];
  rows: string[][];
}): string[] {
  const preservedLines = backendRawLines?.filter((line) => line.trim().length > 0) ?? [];
  return preservedLines.length > 0
    ? preservedLines
    : extractRawTextPreviewLines(columnLabels, rows);
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
  if (sourceType === "Stream / Kafka") return rawLines.length > 0;

  return sourceType === "File / S3"
    && detectedFormat?.toUpperCase() === "TXT"
    && requiresRecordParsing === true
    && rawLines.length > 0;
}
