import assert from "node:assert/strict";
import { buildObjectStoragePrefixAnalysis } from "../src/connectors.mjs";

const prefix = "synthetic-commerce/run-001/click_events/";
const jsonlSamples = new Map([
  [`${prefix}part-00000.jsonl`, '{"user_id":"u-1","product_id":"p-1","event_type":"view","event_ts":"2026-07-01T00:00:00Z"}\n'],
  [`${prefix}part-00001.jsonl`, '{"user_id":"u-2","product_id":"p-2","event_type":"click","event_ts":"2026-07-01T00:00:01Z"}\n'],
  [`${prefix}z=archive/part-00002.jsonl`, '{"user_id":"u-3","product_id":"p-3","event_type":"purchase","event_ts":"2026-07-01T00:00:02Z"}\n'],
]);
const objects = [
  object(`${prefix}part-00001.jsonl`, 140),
  object(`${prefix}_SUCCESS`, 0),
  object(`${prefix}manifest.json`, 300),
  object(`${prefix}.hidden.jsonl`, 30),
  object(`${prefix}README.md`, 20),
  object(`${prefix}z=archive/part-00002.jsonl`, 160),
  object(`${prefix}part-00000.jsonl`, 120),
  { ...object(prefix, 0), __folder: true },
];

const analysis = await buildObjectStoragePrefixAnalysis({
  bucket: "raw-bucket",
  endpoint: "http://127.0.0.1:9000",
  fields: fields("auto"),
  forcePathStyle: true,
  objects,
  prefix,
  readRange: rangeReader(jsonlSamples),
  region: "ap-northeast-2",
  sourceType: "File / S3",
});

assert.deepEqual(analysis.datasetSummary, {
  bucket: "raw-bucket",
  excludedFileCount: 5,
  fileCount: 3,
  format: "JSONL",
  prefix,
  representativeObject: `${prefix}part-00000.jsonl`,
  schemaCompatible: true,
  schemaFingerprint: analysis.draftPatch.schema.schemaFingerprint,
  selectionKind: "prefix",
  totalBytes: 420,
});
assert.equal(analysis.previewRows.length, 1);
assert.equal(configValue(analysis, "Path / Prefix"), prefix);
assert.equal(configValue(analysis, "__Selection Kind"), "prefix");
assert.equal(configValue(analysis, "__Dataset Format"), "JSONL");
assert.equal(configValue(analysis, "__Source Unit Count"), "3");
assert.equal(configValue(analysis, "__Source Total Bytes"), "420");
assert.equal(configValue(analysis, "__Excluded File Count"), "5");
assert.equal(configValue(analysis, "__Sample Object"), `${prefix}part-00000.jsonl`);
assert.equal(configValue(analysis, "__Selected Object"), "");

await assert.rejects(
  buildObjectStoragePrefixAnalysis({
    bucket: "raw-bucket",
    endpoint: "http://127.0.0.1:9000",
    fields: fields("auto"),
    forcePathStyle: true,
    objects: [object(`${prefix}part-00000.jsonl`, 100), object(`${prefix}part-00001.csv`, 100)],
    prefix,
    readRange: rangeReader(jsonlSamples),
    region: "ap-northeast-2",
  }),
  (error) => error?.code === "SOURCE_PREFIX_MIXED_FORMATS" && error?.status === 400,
);

const explicitFormat = await buildObjectStoragePrefixAnalysis({
  bucket: "raw-bucket",
  endpoint: "http://127.0.0.1:9000",
  fields: fields("JSONL"),
  forcePathStyle: true,
  objects: [object(`${prefix}part-00000.jsonl`, 120), object(`${prefix}unrelated.csv`, 90)],
  prefix,
  readRange: rangeReader(jsonlSamples),
  region: "ap-northeast-2",
});
assert.equal(explicitFormat.datasetSummary.fileCount, 1);
assert.equal(explicitFormat.datasetSummary.excludedFileCount, 1);

await assert.rejects(
  buildObjectStoragePrefixAnalysis({
    bucket: "raw-bucket",
    endpoint: "http://127.0.0.1:9000",
    fields: fields("JSONL"),
    forcePathStyle: true,
    objects: [object(`${prefix}part-00000.jsonl`, 120), object(`${prefix}part-00001.jsonl`, 140)],
    prefix,
    readRange: rangeReader(new Map([
      [`${prefix}part-00000.jsonl`, jsonlSamples.get(`${prefix}part-00000.jsonl`)],
      [`${prefix}part-00001.jsonl`, '{"user_id":"u-2","unexpected":true}\n'],
    ])),
    region: "ap-northeast-2",
  }),
  (error) => error?.code === "SOURCE_PREFIX_SCHEMA_MISMATCH" && error?.status === 400,
);

const previousConcurrency = process.env.ASKLAKE_PREFIX_VALIDATION_CONCURRENCY;
process.env.ASKLAKE_PREFIX_VALIDATION_CONCURRENCY = "4";
let activeReaders = 0;
let maximumActiveReaders = 0;
let representativeReadComplete = false;
const concurrencyObjects = Array.from({ length: 9 }, (_, index) => {
  const key = `${prefix}concurrency-${String(index).padStart(2, "0")}.jsonl`;
  return object(key, 96);
});
const concurrencySamples = new Map(
  concurrencyObjects.map(({ Key }, index) => [
    Key,
    `${JSON.stringify({ event_id: `evt-${index}`, event_type: "view" })}\n`,
  ]),
);
const readConcurrencyRange = rangeReader(concurrencySamples);
try {
  await buildObjectStoragePrefixAnalysis({
    bucket: "raw-bucket",
    endpoint: "http://127.0.0.1:9000",
    fields: fields("JSONL"),
    forcePathStyle: true,
    objects: concurrencyObjects,
    prefix,
    readRange: async (range) => {
      if (range.key !== concurrencyObjects[0].Key) {
        assert.equal(representativeReadComplete, true);
      }
      activeReaders += 1;
      maximumActiveReaders = Math.max(maximumActiveReaders, activeReaders);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const content = await readConcurrencyRange(range);
        if (range.key === concurrencyObjects[0].Key) {
          representativeReadComplete = true;
        }
        return content;
      } finally {
        activeReaders -= 1;
      }
    },
    region: "ap-northeast-2",
  });
  assert.equal(maximumActiveReaders, 4);
} finally {
  if (previousConcurrency === undefined) {
    delete process.env.ASKLAKE_PREFIX_VALIDATION_CONCURRENCY;
  } else {
    process.env.ASKLAKE_PREFIX_VALIDATION_CONCURRENCY = previousConcurrency;
  }
}

console.log("Prefix source connector contract verified.");

function fields(fileType) {
  return [
    ["Endpoint URL", "http://127.0.0.1:9000"],
    ["Region", "ap-northeast-2"],
    ["Bucket / Stage Name", "raw-bucket"],
    ["Path / Prefix", prefix],
    ["Access Key", "test-access"],
    ["Secret Key", "test-secret"],
    ["Use Path Style", "true"],
    ["File Type", fileType],
    ["__Selection Kind", "prefix"],
  ];
}

function object(Key, Size) {
  return { Key, LastModified: new Date("2026-07-13T00:00:00Z"), Size };
}

function rangeReader(samples) {
  return async ({ endByte, key, startByte }) => {
    const content = Buffer.from(samples.get(key) ?? "", "utf8");
    return content.subarray(startByte, endByte + 1);
  };
}

function configValue(analysisResult, label) {
  return analysisResult.draftPatch.source.sourceConfig.find(([fieldLabel]) => fieldLabel === label)?.[1];
}
