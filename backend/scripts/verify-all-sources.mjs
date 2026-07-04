import { spawn } from "node:child_process";

const port = Number(process.env.ASKLAKE_VERIFY_SOURCES_PORT || 18082);
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "wishuponastar",
  PORT: String(port),
};

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env,
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
  await verify("File / S3", [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", "nyc_taxi/csv/"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("REST API", [
    ["Method", "GET"],
    ["Endpoint URL", `${baseUrl}/api/harness/rest-sample`],
    ["Accept", "application/json"],
  ], (result) => result.draftPatch.schema.columns.length > 0);

  await verify("PostgreSQL", [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_SOURCE_PGPORT || "15432"],
    ["Database Name", "asklake_sources"],
    ["Schema", "public"],
    ["Username", "asklake"],
    ["Password / Auth Token", process.env.ASKLAKE_SOURCE_PGPASSWORD || "asklake"],
    ["DATASET OR TABLE SELECTOR", "nyc_taxi_sample"],
  ], (result) => result.draftPatch.schema.columns.length > 0 && result.draftPatch.source.sourceType === "PostgreSQL");

  await verify("MongoDB", [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_MONGO_PORT || "27018"],
    ["Database Name", "asklake_sources"],
    ["DATASET OR TABLE SELECTOR", "app_events"],
  ], (result) => result.draftPatch.schema.columns.length > 0 && result.draftPatch.source.sourceType === "MongoDB");

  await verify("Data Lake", [
    ["Path", "s3://m3-raw/nyc_taxi/yellow_parquet/nyc-taxi-data-20gb/nyc-taxi-data-20gb/data/yellow/"],
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.assets.length > 0);

  if (process.env.ASKLAKE_VERIFY_KAFKA === "true") {
    await verify("Stream / Kafka", [
      ["Broker / Endpoint", process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092"],
      ["TOPIC / QUEUE NAME", process.env.ASKLAKE_KAFKA_TOPIC || "asklake-source-events"],
      ["CONSUMER GROUP ID", "asklake-source-verify"],
    ], (result) => result.assets.length > 0);
  } else {
    console.log("Kafka verification skipped. Set ASKLAKE_VERIFY_KAFKA=true after running the AskLake Kafka fixture.");
  }

  console.log("verify-all-sources: ok");
} finally {
  child.kill("SIGTERM");
}

async function verify(sourceType, sourceConfig, assertResult) {
  const result = await post("/api/etl/sources/test", { sourceConfig, sourceType });
  if (result.status !== "success") throw new Error(`${sourceType} did not return success.`);
  if (!assertResult(result)) throw new Error(`${sourceType} returned success without expected metadata.`);
  console.log(`${sourceType}: ok`);
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
