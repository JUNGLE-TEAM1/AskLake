import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const region = process.env.MINIO_REGION || "us-east-1";
const accessKeyId = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
const secretAccessKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
const bucket = process.env.MINIO_BUCKET || "m3-raw";
const key = process.env.ASKLAKE_CLICK_LOG_KEY || "asklake-fixtures/txt/click-events-whitespace-100.log";
const lineCount = boundedInteger(process.env.ASKLAKE_CLICK_LOG_COUNT, 100, 1, 10_000);
const startTime = parseStartTime(process.env.ASKLAKE_CLICK_LOG_START_TIME || "2026-07-12T09:00:00Z");

const client = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region,
});

const lines = Array.from({ length: lineCount }, (_, index) => buildClickLogLine(index, startTime));
const body = `${lines.join("\n")}\n`;

await ensureBucket();
await client.send(new PutObjectCommand({
  Body: body,
  Bucket: bucket,
  ContentType: "text/plain; charset=utf-8",
  Key: key,
}));

const stored = await readStoredObject();
const storedLines = stored.split(/\r?\n/).filter(Boolean);
const invalidRows = storedLines
  .map((line, index) => ({ fieldCount: line.trim().split(/\s+/).length, lineNumber: index + 1 }))
  .filter((row) => row.fieldCount !== 10);

if (storedLines.length !== lineCount || invalidRows.length > 0) {
  throw new Error(`Click log fixture verification failed: expected ${lineCount} rows with 10 fields, got ${storedLines.length} rows and ${invalidRows.length} invalid rows.`);
}

console.log(JSON.stringify({
  bucket,
  bytes: Buffer.byteLength(stored, "utf8"),
  delimiter: "whitespace (\\s+)",
  fieldOrder: [
    "event_time",
    "event_id",
    "customer_id",
    "session_id",
    "event_type",
    "page_path",
    "element_id",
    "device",
    "region",
    "latency_ms",
  ],
  firstLine: storedLines[0],
  key,
  lastLine: storedLines.at(-1),
  lineCount: storedLines.length,
  objectUri: `s3://${bucket}/${key}`,
}, null, 2));

function buildClickLogLine(index, baseTime) {
  const routes = [
    ["/", "nav_home"],
    ["/products/101", "product_card"],
    ["/search?q=data-lake", "search_button"],
    ["/cart", "add_to_cart"],
    ["/checkout", "checkout_button"],
    ["/pricing", "pricing_cta"],
    ["/docs/getting-started", "docs_link"],
    ["/account/orders", "order_row"],
  ];
  const devices = ["web", "ios", "android"];
  const regions = ["KR", "US", "JP", "SG"];
  const sequence = index + 1;
  const [pagePath, elementId] = routes[index % routes.length];
  const eventTime = new Date(baseTime + index * 1_000).toISOString();
  const eventId = `EVT-${String(sequence).padStart(4, "0")}`;
  const customerId = `CUS-${String(((index * 7) % 25) + 1).padStart(3, "0")}`;
  const sessionId = `SES-${String(Math.floor(index / 5) + 1).padStart(4, "0")}`;
  const latencyMs = 35 + ((index * 17) % 220);
  return [
    eventTime,
    eventId,
    customerId,
    sessionId,
    "click",
    pagePath,
    elementId,
    devices[index % devices.length],
    regions[index % regions.length],
    latencyMs,
  ].join(" ");
}

async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function readStoredObject() {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`MinIO object body is empty: s3://${bucket}/${key}`);
  if (typeof result.Body.transformToString === "function") {
    return result.Body.transformToString("utf-8");
  }
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function parseStartTime(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid ASKLAKE_CLICK_LOG_START_TIME: ${value}`);
  return parsed;
}
