import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || (process.platform === "win32" ? "python" : "python3");
const port = Number(process.env.ASKLAKE_FASTAPI_SOURCES_PORT || 18085);
const baseUrl = process.env.ASKLAKE_FASTAPI_SOURCES_BASE_URL || `http://127.0.0.1:${port}`;
const restFixturePort = Number(process.env.ASKLAKE_SOURCE_REST_PORT || 19085);
const restFixtureUrl = `http://127.0.0.1:${restFixturePort}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_SOURCES_START_SERVER !== "false";
const env = {
  ...process.env,
  ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS: process.env.ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS || "10000",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "wishuponastar",
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let restFixtureProcess = null;

try {
  ensureFastApiPythonDependencies();
  if (shouldStartServer) serverProcess = startFastApiServer();
  restFixtureProcess = startRestFixtureServer();
  await waitForFastApiApp();
  await waitForRestFixture();
  await verifyAllSources();
  console.log("verify-fastapi-sources: ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (restFixtureProcess) restFixtureProcess.kill("SIGTERM");
}

async function verifyAllSources() {
  await verify("File / S3 CSV", objectStorageConfig("asklake-fixtures/csv/"));
  await verify("File / S3 JSON", objectStorageConfig("asklake-fixtures/json/"));
  await verify("File / S3 JSONL", objectStorageConfig("asklake-fixtures/jsonl/"));
  await verify("File / S3 TSV", objectStorageConfig("asklake-fixtures/tsv/"));
  await verify("File / S3 TXT", objectStorageConfig("asklake-fixtures/txt/"));
  await verify("REST API", [
    ["Method", "GET"],
    ["Endpoint URL", `${restFixtureUrl}/events`],
    ["Accept", "application/json"],
  ]);
  await verify("PostgreSQL", [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_SOURCE_PGPORT || "15432"],
    ["Database Name", "asklake_sources"],
    ["Schema", "public"],
    ["Username", "asklake"],
    ["Password / Auth Token", process.env.ASKLAKE_SOURCE_PGPASSWORD || "asklake"],
    ["DATASET OR TABLE SELECTOR", "nyc_taxi_sample"],
  ]);
  await verify("MongoDB", [
    ["Endpoint / Host", "127.0.0.1"],
    ["Port", process.env.ASKLAKE_MONGO_PORT || "27018"],
    ["Database Name", "asklake_sources"],
    ["DATASET OR TABLE SELECTOR", "app_events"],
  ]);
  await verify("Data Lake Parquet", [
    ["Path", "s3://m3-raw/asklake-fixtures/parquet/"],
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ], (result) => result.assets?.length > 0 && result.draftPatch?.source?.sourceType === "Data Lake Parquet");
  if (process.env.ASKLAKE_VERIFY_KAFKA === "true") {
    await verify("Kafka JSON", [
      ["Broker / Endpoint", process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092"],
      ["TOPIC / QUEUE NAME", process.env.ASKLAKE_KAFKA_TOPIC || "asklake-source-events"],
      ["CONSUMER GROUP ID", "asklake-fastapi-source-verify"],
    ]);
  } else {
    console.log("Kafka verification skipped. Set ASKLAKE_VERIFY_KAFKA=true after running source fixtures.");
  }
}

function objectStorageConfig(prefix) {
  return [
    ["Endpoint URL", env.MINIO_ENDPOINT],
    ["Region", "us-east-1"],
    ["Bucket / Stage Name", "m3-raw"],
    ["Path / Prefix", prefix],
    ["Access Key", env.MINIO_ACCESS_KEY],
    ["Secret Key", env.MINIO_SECRET_KEY],
    ["Use Path Style", "true"],
  ];
}

async function verify(sourceType, sourceConfig, assertResult = (result) => result.draftPatch?.schema?.columns?.length > 0) {
  const result = await post("/api/etl/sources/test", { sourceConfig, sourceType });
  if (result.status !== "success") throw new Error(`${sourceType} did not return success.`);
  if (!assertResult(result)) throw new Error(`${sourceType} returned no expected metadata.`);
  console.log(`${sourceType}: ok`);
}

function ensureFastApiPythonDependencies() {
  const result = spawnSync(pythonBin, ["-c", "import fastapi, pydantic_settings, sqlalchemy, uvicorn"], {
    cwd: backendDir,
    env,
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const lastOutputLine = output.split("\n").filter(Boolean).at(-1);
    throw new Error([
      "FastAPI Python dependencies are not installed for this interpreter.",
      `python: ${pythonBin}`,
      "Run `cd backend && python -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON.",
      lastOutputLine,
    ].filter(Boolean).join("\n"));
  }
}

function startFastApiServer() {
  const child = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[fastapi] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[fastapi] ${chunk}`));
  return child;
}

function startRestFixtureServer() {
  const child = spawn(process.execPath, ["scripts/source-rest-fixture-server.mjs"], {
    cwd: backendDir,
    env: { ...process.env, ASKLAKE_SOURCE_REST_PORT: String(restFixturePort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[rest-source] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[rest-source] ${chunk}`));
  return child;
}

async function waitForFastApiApp() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const schema = await get("/openapi.json");
      if (schema?.openapi) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`FastAPI app did not become ready at ${baseUrl}/openapi.json.`);
}

async function waitForRestFixture() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${restFixtureUrl}/health`);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`REST source fixture did not become healthy at ${restFixtureUrl}/health.`);
}

async function get(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return readResponse(response);
}

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function readResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
