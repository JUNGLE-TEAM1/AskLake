export const S3_SCHEME = "s3a";

export type S3ParsedPath = {
  bucket: string;
  path: string;
  prefix: string;
  scheme: string;
  segments: string[];
};

export function normalizePrefix(prefix: string | undefined) {
  const normalized = (prefix ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

  if (!normalized) return "";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

export function ensureTrailingSlash(value: string) {
  if (!value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

export function parseS3Path(value: string | undefined): S3ParsedPath {
  const rawValue = (value ?? "").trim();
  const match = rawValue.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]+)\/?(.*)$/i);
  const scheme = match?.[1] || S3_SCHEME;
  const bucket = match?.[2] || "";
  const prefix = normalizePrefix(match?.[3] ?? "");
  const path = bucket ? buildS3Path({ bucket, prefix, scheme }) : rawValue;

  return {
    bucket,
    path,
    prefix,
    scheme,
    segments: prefix.split("/").filter(Boolean),
  };
}

export function buildS3Path({
  bucket,
  prefix,
  scheme = S3_SCHEME,
}: {
  bucket: string;
  prefix?: string;
  scheme?: string;
}) {
  const normalizedBucket = bucket.trim();
  if (!normalizedBucket) return "";
  return `${scheme}://${normalizedBucket}/${normalizePrefix(prefix)}`;
}

export function compactS3Segments(segments: string[], maxVisible = 3) {
  if (segments.length <= maxVisible) return segments;
  return [segments[0], "...", ...segments.slice(-(maxVisible - 1))];
}
