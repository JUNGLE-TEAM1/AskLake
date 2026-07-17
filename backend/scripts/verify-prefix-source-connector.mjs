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
  readSample: async ({ key }) => jsonlSamples.get(key) ?? "",
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
assert.match(configValue(analysis, "__Source Inventory Fingerprint"), /^[a-f0-9]{64}$/);
assert.equal(configValue(analysis, "__Source Identity Contract Version"), "1");
assert.equal(configValue(analysis, "__Excluded File Count"), "5");
assert.equal(configValue(analysis, "__Sample Object"), `${prefix}part-00000.jsonl`);
assert.equal(configValue(analysis, "__Selected Object"), "");

const orderingAnalysis = await buildObjectStoragePrefixAnalysis({
  bucket: "raw-bucket",
  endpoint: "http://127.0.0.1:9000",
  fields: [
    ...fields("JSONL").filter(([label]) => label !== "Path / Prefix"),
    ["Path / Prefix", "ordering/"],
  ],
  forcePathStyle: true,
  objects: [
    object("ordering/a.jsonl", 20),
    object("ordering/Z.jsonl", 10),
  ],
  prefix: "ordering/",
  readSample: async () => '{"id":1}\n',
  region: "ap-northeast-2",
});
assert.equal(
  configValue(orderingAnalysis, "__Source Inventory Fingerprint"),
  "95f26f6e07f97679944da87ec1dd4ae1caee35f1a37e8bc8d440d5b2a167b395",
  "the connector and Spark runtime must use the same UTF-8 byte ordering",
);

await assert.rejects(
  buildObjectStoragePrefixAnalysis({
    bucket: "raw-bucket",
    endpoint: "http://127.0.0.1:9000",
    fields: fields("auto"),
    forcePathStyle: true,
    objects: [object(`${prefix}part-00000.jsonl`, 100), object(`${prefix}part-00001.csv`, 100)],
    prefix,
    readSample: async () => "",
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
  readSample: async ({ key }) => jsonlSamples.get(key) ?? "",
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
    readSample: async ({ key }) => key.endsWith("part-00000.jsonl")
      ? jsonlSamples.get(`${prefix}part-00000.jsonl`)
      : '{"user_id":"u-2","unexpected":true}\n',
    region: "ap-northeast-2",
  }),
  (error) => error?.code === "SOURCE_PREFIX_SCHEMA_MISMATCH" && error?.status === 400,
);

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

function configValue(analysisResult, label) {
  return analysisResult.draftPatch.source.sourceConfig.find(([fieldLabel]) => fieldLabel === label)?.[1];
}
