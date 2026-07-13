import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const region = process.env.MINIO_REGION || "us-east-1";
const accessKeyId = process.env.MINIO_ACCESS_KEY || "m3admin";
const secretAccessKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
const bucket = process.env.MINIO_BUCKET || "m3-raw";
const localSampleDir = path.resolve(process.env.ASKLAKE_LOCAL_SAMPLE_DIR || path.join(os.tmpdir(), "asklake-1gb-samples"));
const targetBytes = Number(process.env.ASKLAKE_SAMPLE_TARGET_MIB || 1024) * 1024 * 1024;
const rangeExtraBytes = Number(process.env.ASKLAKE_SAMPLE_RANGE_EXTRA_MIB || 32) * 1024 * 1024;
const client = new S3Client({ credentials: { accessKeyId, secretAccessKey }, endpoint, forcePathStyle: true, region });

const manifest = {
  bucket,
  createdAt: new Date().toISOString(),
  endpoint,
  localSampleDir,
  notes: [],
  samples: [],
  targetBytes,
};

await fs.mkdir(localSampleDir, { recursive: true });
await fs.rm(path.join(localSampleDir, "csv"), { force: true, recursive: true });
await fs.rm(path.join(localSampleDir, "jsonl"), { force: true, recursive: true });
await fs.rm(path.join(localSampleDir, "json"), { force: true, recursive: true });
await fs.rm(path.join(localSampleDir, "txt"), { force: true, recursive: true });
await fs.rm(path.join(localSampleDir, "parquet"), { force: true, recursive: true });

await createDelimitedSample({
  key: process.env.ASKLAKE_SAMPLE_CSV_KEY || "nyc_taxi/csv/2019-Nov.csv",
  outputPath: path.join(localSampleDir, "csv", "2019-Nov.sample.csv"),
  type: "csv",
});

await createDelimitedSample({
  key: process.env.ASKLAKE_SAMPLE_JSONL_KEY || "amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl",
  outputPath: path.join(localSampleDir, "jsonl", "Cell_Phones_and_Accessories.sample.jsonl"),
  type: "jsonl",
});

await createJsonArraySample({
  key: process.env.ASKLAKE_SAMPLE_JSON_KEY || "annotations/annotations.json",
  outputPath: path.join(localSampleDir, "json", "annotations.sample.json"),
  type: "json",
});

await createTextSamples();
await createParquetSamples();

const localManifestPath = path.join(localSampleDir, "manifest.json");
await fs.writeFile(localManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ localManifestPath, notes: manifest.notes, samples: summarizeSamples(manifest.samples) }, null, 2));

async function createDelimitedSample({ key, outputPath, type }) {
  const head = await headObject(key);
  const requestedBytes = Math.min(head.bytes, targetBytes + rangeExtraBytes);
  await downloadRangeToFile({ key, outputPath, rangeEndInclusive: requestedBytes - 1 });
  await truncateAtLastNewline(outputPath, targetBytes);
  const bytes = await fileSize(outputPath);
  manifest.samples.push({ bytes, key, outputPath, targetBytes, type });
  return { bytes, outputPath };
}

async function createJsonArraySample({ key, outputPath, type }) {
  const head = await headObject(key);
  const requestedBytes = Math.min(head.bytes, targetBytes + rangeExtraBytes);
  await downloadRangeToFile({ key, outputPath, rangeEndInclusive: requestedBytes - 1 });
  await truncateJsonArrayAtObjectBoundary(outputPath, targetBytes);
  const bytes = await fileSize(outputPath);
  manifest.samples.push({ bytes, key, outputPath, targetBytes, type });
  return { bytes, outputPath };
}

async function createTextSamples() {
  const keys = (process.env.ASKLAKE_SAMPLE_TXT_KEYS || "misc_text/nips_annotation_data_0522.txt,misc_text/test_data.txt,misc_text/val_data.txt")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let writtenBytes = 0;
  for (const [index, key] of keys.entries()) {
    if (writtenBytes >= targetBytes) break;
    const head = await headObject(key);
    const bytesToRead = Math.min(head.bytes, targetBytes - writtenBytes);
    const outputPath = path.join(localSampleDir, "txt", `text_sample_${String(index + 1).padStart(3, "0")}.txt`);
    await downloadRangeToFile({ key, outputPath, rangeEndInclusive: bytesToRead - 1 });
    const bytes = await fileSize(outputPath);
    writtenBytes += bytes;
    manifest.samples.push({ bytes, key, outputPath, targetBytes, type: "txt" });
  }
  if (writtenBytes < targetBytes) {
    manifest.notes.push(`TXT source only provided ${formatBytes(writtenBytes)}. Validation uses the available slice.`);
  }
}

async function createParquetSamples() {
  const parquetPrefix = process.env.ASKLAKE_SAMPLE_PARQUET_PREFIX || "nyc_taxi/yellow_parquet/";
  const keys = await listKeys(parquetPrefix, ".parquet");
  let writtenBytes = 0;
  for (const [index, key] of keys.entries()) {
    if (writtenBytes >= targetBytes) break;
    const outputPath = path.join(localSampleDir, "parquet", `part-${String(index).padStart(5, "0")}.parquet`);
    await downloadRangeToFile({ key, outputPath });
    const bytes = await fileSize(outputPath);
    writtenBytes += bytes;
    manifest.samples.push({ bytes, key, outputPath, targetBytes, type: "parquet", note: "Parquet slices use whole files to preserve row groups and footers." });
  }
  if (writtenBytes < targetBytes) {
    manifest.notes.push(`Parquet prefix only provided ${formatBytes(writtenBytes)}.`);
  }
}

async function downloadRangeToFile({ key, outputPath, rangeEndInclusive }) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const request = { Bucket: bucket, Key: key };
  if (Number.isFinite(rangeEndInclusive)) request.Range = `bytes=0-${Math.max(0, rangeEndInclusive)}`;
  const result = await client.send(new GetObjectCommand(request));
  await pipeline(result.Body, createWriteStream(outputPath));
}

async function truncateAtLastNewline(filePath, preferredBytes) {
  if (!existsSync(filePath)) return;
  const stats = await fs.stat(filePath);
  if (stats.size <= preferredBytes) return;
  const readSize = Math.min(stats.size, rangeExtraBytes);
  const readStart = stats.size - readSize;
  const handle = await fs.open(filePath, "r+");
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, readStart);
    const preferredOffset = Math.max(0, preferredBytes - readStart);
    const searchEnd = Math.min(buffer.length, preferredOffset + 1024 * 1024);
    let newlineIndex = buffer.lastIndexOf(0x0a, searchEnd);
    if (newlineIndex < 0) newlineIndex = buffer.lastIndexOf(0x0a);
    if (newlineIndex > 0) await handle.truncate(readStart + newlineIndex + 1);
  } finally {
    await handle.close();
  }
}

async function truncateJsonArrayAtObjectBoundary(filePath, preferredBytes) {
  const stats = await fs.stat(filePath);
  const readSize = Math.min(stats.size, rangeExtraBytes);
  const readStart = stats.size - readSize;
  const handle = await fs.open(filePath, "r+");
  let truncateSize = 0;
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, readStart);
    const preferredOffset = Math.max(0, preferredBytes - readStart);
    const searchEnd = Math.min(buffer.length, preferredOffset + 4 * 1024 * 1024);
    const candidates = [Buffer.from("\r\n    },"), Buffer.from("\n    },")];
    let boundary = -1;
    let boundaryLength = 0;
    for (const marker of candidates) {
      const index = buffer.lastIndexOf(marker, searchEnd);
      if (index > boundary) {
        boundary = index;
        boundaryLength = marker.length;
      }
    }
    if (boundary < 0) {
      throw new Error(`JSON array boundary not found near ${formatBytes(preferredBytes)} in ${filePath}`);
    }
    truncateSize = readStart + boundary + boundaryLength - 1;
    await handle.truncate(truncateSize);
  } finally {
    await handle.close();
  }
  if (truncateSize > 0) await fs.appendFile(filePath, "\n]");
}

async function headObject(key) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { bytes: Number(head.ContentLength ?? 0), key };
}

async function fileSize(filePath) {
  const stats = await fs.stat(filePath);
  return stats.size;
}

async function listKeys(prefix, suffix) {
  const keys = [];
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
      Prefix: prefix,
    }));
    for (const object of result.Contents ?? []) {
      if (object.Key?.toLowerCase().endsWith(suffix)) keys.push(object.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return keys.sort();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function summarizeSamples(samples) {
  return Object.values(samples.reduce((summary, sample) => {
    const current = summary[sample.type] ?? { bytes: 0, count: 0, type: sample.type };
    current.bytes += sample.bytes;
    current.count += 1;
    current.humanBytes = formatBytes(current.bytes);
    summary[sample.type] = current;
    return summary;
  }, {}));
}
