export function buildKafkaPreviewMetadata(messages, parsedFormat) {
  const rawPreviewLines = messages
    .map((message) => String(message ?? ""))
    .filter((message) => message.trim());
  const normalizedFormat = String(parsedFormat ?? "").trim().toLowerCase();

  return {
    detectedFormat: normalizedFormat && normalizedFormat !== "kafka"
      ? normalizedFormat.toUpperCase()
      : undefined,
    rawPreviewLines,
    requiresRecordParsing: normalizedFormat === "txt" && rawPreviewLines.length > 0,
  };
}
