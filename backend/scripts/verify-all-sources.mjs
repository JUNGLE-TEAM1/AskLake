import { spawn } from "node:child_process";

const port = Number(process.env.ASKLAKE_VERIFY_SOURCES_PORT || 18082);
const baseUrl = `http://127.0.0.1:${port}`;
const restFixturePort = Number(process.env.ASKLAKE_SOURCE_REST_PORT || 19082);
const restFixtureUrl = `http://127.0.0.1:${restFixturePort}`;
const env = {
  ...process.env,
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "wishuponastar",
  ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS: process.env.ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS || "10000",
  PORT: String(port),
};

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const restFixture = spawn(process.execPath, ["scripts/source-rest-fixture-server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, ASKLAKE_SOURCE_REST_PORT: String(restFixturePort) },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  if (
    text.includes("TimeoutNegativeWarning") ||
    text.includes("Timeout duration was set to 1") ||
    text.includes("--trace-warnings")
  ) {
    return;
  }
  process.stderr.write(`[backend] ${chunk}`);
});

try {
  await waitForHealth();
  await waitForRestFixture();
  await verify("File / S3 CSV", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "asklake-fixtures/csv/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("File / S3 JSON", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "asklake-fixtures/json/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("File / S3 JSONL", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "asklake-fixtures/jsonl/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("File / S3 TSV", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "asklake-fixtures/tsv/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("File / S3 TXT", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "asklake-fixtures/txt/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("REST API", [
    ["Method", "GET"],
    ["Endpoint URL", `${restFixtureUrl}/events`],
    ["Accept", "application/json"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  const postgresConnection = [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_SOURCE_PGPORT || "15432"],
    ["Database Name", "asklake_sources"],
    ["Schema", "public"],
    ["Username", "asklake"],
    ["Password / Auth Token", process.env.ASKLAKE_SOURCE_PGPASSWORD || "asklake"],
  ];
  await verifyDiscovery("PostgreSQL", postgresConnection, "nyc_taxi_sample");
  await verifySelectionRequired("PostgreSQL", postgresConnection);
  await verify("PostgreSQL", [
    ...postgresConnection,
    ["DATASET OR TABLE SELECTOR", "nyc_taxi_sample"],
  ], (result) => result.draftPatch.schema.columns.length > 0 && result.draftPatch.source.sourceType === "PostgreSQL");

  const mongoConnection = [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_MONGO_PORT || "27018"],
    ["Database Name", "asklake_sources"],
  ];
  await verifyDiscovery("MongoDB", mongoConnection, "app_events");
  await verifySelectionRequired("MongoDB", mongoConnection);
  await verify("MongoDB", [
    ...mongoConnection,
    ["DATASET OR TABLE SELECTOR", "app_events"],
  ], (result) => result.draftPatch.schema.columns.length > 0 && result.draftPatch.source.sourceType === "MongoDB");

  await verify("Data Lake Parquet", [
    ["Path", "s3://m3-raw/asklake-fixtures/parquet/"],
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.assets.length > 0 && result.draftPatch.source.sourceType === "Data Lake Parquet");

  if (process.env.ASKLAKE_VERIFY_KAFKA === "true") {
    await verify("Kafka JSON", [
      ["Broker / Endpoint", process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092"],
      ["TOPIC / QUEUE NAME", process.env.ASKLAKE_KAFKA_TOPIC || "asklake-source-events"],
      ["CONSUMER GROUP ID", "asklake-source-verify"],
    ], (result) => result.assets.length > 0 && result.draftPatch.schema.columns.length > 0);
  } else {
    console.log("Kafka verification skipped. Set ASKLAKE_VERIFY_KAFKA=true after running the AskLake Kafka fixture.");
  }

  console.log("verify-all-sources: ok");
} finally {
  child.kill("SIGTERM");
  restFixture.kill("SIGTERM");
}

async function verify(sourceType, sourceConfig, assertResult) {
  const result = await post("/api/etl/sources/test", { sourceConfig, sourceType });
  if (result.status !== "success") throw new Error(`${sourceType} did not return success.`);
  if (!assertResult(result)) throw new Error(`${sourceType} returned success without expected metadata.`);
  console.log(`${sourceType}: ok`);
}

async function verifyDiscovery(sourceType, sourceConfig, expectedAsset) {
  const result = await post("/api/etl/sources/assets", { prefix: "", sourceConfig, sourceType });
  if (!result.assets.some(([name]) => name === expectedAsset)) {
    throw new Error(`${sourceType} discovery did not include ${expectedAsset}.`);
  }
  console.log(`${sourceType} discovery: ok`);
}

async function verifySelectionRequired(sourceType, sourceConfig) {
  try {
    await post("/api/etl/sources/test", { sourceConfig, sourceType });
  } catch (error) {
    if (/400/.test(String(error))) {
      console.log(`${sourceType} selection guard: ok`);
      return;
    }
    throw error;
  }
  throw new Error(`${sourceType} preview unexpectedly succeeded without a selected target.`);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Backend did not become healthy.");
}

async function waitForRestFixture() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await fetch(`${restFixtureUrl}/health`);
      if (health.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`REST source fixture did not become healthy at ${restFixtureUrl}/health.`);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return readResponse(response);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function readResponse(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
