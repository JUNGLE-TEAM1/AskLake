export type SourceFieldRows = Array<[string, string]>;

const AWS_PRESENTATION_ONLY_FIELD_LABELS = new Set(["Endpoint URL", "Access Key", "Secret Key"]);
const CREDENTIAL_FIELD_LABELS = new Set(["Access Key", "Secret Key"]);

export function isMaskedSourceCredential(value: string): boolean {
  const normalized = String(value ?? "").trim();
  return /^(?:\*+|•+|●+|·+|\[?redacted\]?|masked)$/i.test(normalized);
}

export function shouldReplaceSourceRuntimeDefault(value: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || normalized.startsWith("replace-with-");
}

export function sanitizeSourceConnectorFields(sourceType: string, fields: SourceFieldRows): SourceFieldRows {
  if (sourceType !== "File / S3") return fields;
  const awsObjectStorage = isAwsObjectStorage(fields);
  return fields.map(([label, value]) => [
    label,
    awsObjectStorage && AWS_PRESENTATION_ONLY_FIELD_LABELS.has(label)
      ? ""
      : CREDENTIAL_FIELD_LABELS.has(label) && isMaskedSourceCredential(value)
        ? ""
        : value,
  ]);
}

function isAwsObjectStorage(fields: SourceFieldRows) {
  const buildProvider = String(import.meta.env?.VITE_OBJECT_STORAGE_PROVIDER ?? "").trim().toLowerCase();
  const fieldProvider = fieldValue(fields, "Storage Provider").toLowerCase();
  return buildProvider === "aws" || ["aws", "amazon s3", "s3"].includes(fieldProvider);
}

function fieldValue(fields: SourceFieldRows, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}
