import { parseSourceSample } from "./profile.mjs";

const DEFAULT_PREFIX_VALIDATION_CONCURRENCY = 8;
const MAX_PREFIX_VALIDATION_CONCURRENCY = 32;
const DEFAULT_PREFIX_INITIAL_SAMPLE_BYTES = 64 * 1024;
const MIN_PREFIX_INITIAL_SAMPLE_BYTES = 4 * 1024;

export function prefixValidationConcurrency(environment = process.env) {
  const configured = Number(environment?.ASKLAKE_PREFIX_VALIDATION_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_PREFIX_VALIDATION_CONCURRENCY;
  }
  return Math.min(Math.max(1, Math.trunc(configured)), MAX_PREFIX_VALIDATION_CONCURRENCY);
}

export function prefixInitialSampleBytes(environment = process.env) {
  const configured = Number(environment?.ASKLAKE_PREFIX_INITIAL_SAMPLE_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_PREFIX_INITIAL_SAMPLE_BYTES;
  }
  return Math.max(MIN_PREFIX_INITIAL_SAMPLE_BYTES, Math.trunc(configured));
}

export async function mapSettledWithConcurrency(items, concurrency, mapper) {
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) return [];

  const parsedConcurrency = Number(concurrency);
  const workerCount = Math.min(
    values.length,
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? Math.max(1, Math.trunc(parsedConcurrency))
      : 1,
  );
  const results = new Array(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(values[index], index),
        };
      } catch (reason) {
        results[index] = { reason, status: "rejected" };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function readAdaptivePrefixSample({
  initialBytes = prefixInitialSampleBytes(),
  key,
  maxBytes,
  objectSize,
  readRange,
  rowLimit = 10,
}) {
  if (typeof readRange !== "function") {
    throw new TypeError("Prefix adaptive sample reader requires readRange.");
  }

  const normalizedMaximum = positiveInteger(maxBytes, DEFAULT_PREFIX_INITIAL_SAMPLE_BYTES);
  const normalizedObjectSize = nonNegativeIntegerOrNull(objectSize);
  const effectiveMaximum = normalizedObjectSize === null
    ? normalizedMaximum
    : Math.min(normalizedMaximum, normalizedObjectSize);
  const normalizedInitial = Math.min(
    effectiveMaximum,
    positiveInteger(initialBytes, DEFAULT_PREFIX_INITIAL_SAMPLE_BYTES),
  );
  const normalizedRowLimit = positiveInteger(rowLimit, 10);

  if (effectiveMaximum === 0) {
    return {
      parsedSample: parseSourceSample(key, "", { maxRows: normalizedRowLimit }),
      rangeCount: 0,
      reachedEnd: true,
      requestedBytes: 0,
    };
  }

  let content = Buffer.alloc(0);
  let rangeCount = 0;
  let reachedEnd = false;
  let targetBytes = Math.max(1, normalizedInitial);

  while (content.length < effectiveMaximum) {
    const startByte = content.length;
    const endByte = Math.min(targetBytes, effectiveMaximum) - 1;
    const requestedLength = endByte - startByte + 1;
    const rawChunk = await readRange({
      endByte,
      key,
      startByte,
    });
    const chunk = toBuffer(rawChunk).subarray(0, Math.max(0, requestedLength));
    rangeCount += 1;
    content = Buffer.concat([content, chunk], content.length + chunk.length);

    if (
      chunk.length < requestedLength
      || (normalizedObjectSize !== null && content.length >= normalizedObjectSize)
    ) {
      reachedEnd = true;
    }

    const parsedSample = parseBoundedSample({
      content,
      key,
      reachedEnd,
      rowLimit: normalizedRowLimit,
    });
    if (
      reachedEnd
      || content.length >= effectiveMaximum
      || sampleIsSufficient(key, content, parsedSample, normalizedRowLimit)
    ) {
      return {
        parsedSample,
        rangeCount,
        reachedEnd,
        requestedBytes: content.length,
      };
    }

    if (chunk.length === 0) {
      return {
        parsedSample,
        rangeCount,
        reachedEnd: true,
        requestedBytes: content.length,
      };
    }
    targetBytes = Math.min(effectiveMaximum, Math.max(content.length + 1, targetBytes * 2));
  }

  return {
    parsedSample: parseBoundedSample({
      content,
      key,
      reachedEnd,
      rowLimit: normalizedRowLimit,
    }),
    rangeCount,
    reachedEnd,
    requestedBytes: content.length,
  };
}

function parseBoundedSample({ content, key, reachedEnd, rowLimit }) {
  const text = content.toString("utf8");
  const parseableText = reachedEnd || isJsonDocumentKey(key)
    ? text
    : completeLinePrefix(text);
  return parseSourceSample(key, parseableText, { maxRows: rowLimit });
}

function sampleIsSufficient(key, content, parsedSample, rowLimit) {
  if ((parsedSample?.rows?.length ?? 0) >= rowLimit) return true;
  if (!isJsonDocumentKey(key)) return false;
  try {
    JSON.parse(content.toString("utf8").trim());
    return true;
  } catch {
    return false;
  }
}

function completeLinePrefix(value) {
  const lastNewline = String(value ?? "").lastIndexOf("\n");
  return lastNewline >= 0 ? value.slice(0, lastNewline + 1) : "";
}

function isJsonDocumentKey(key) {
  const normalized = String(key ?? "").trim().toLowerCase();
  return normalized.endsWith(".json") && !normalized.endsWith(".jsonl");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function nonNegativeIntegerOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ""), "utf8");
}
