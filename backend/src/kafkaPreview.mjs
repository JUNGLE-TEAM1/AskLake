import { randomUUID } from "node:crypto";

export function buildKafkaPreviewConsumerGroups(fields, iamMode, fieldValue) {
  return {
    configuredGroupId: iamMode
      ? "server-assigned-on-job-create"
      : fieldValue(fields, "CONSUMER GROUP ID") || "asklake-schema-preview",
    sampleGroupId: iamMode
      ? `asklake-preview-${randomUUID()}`
      : `asklake-schema-preview-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
}

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
