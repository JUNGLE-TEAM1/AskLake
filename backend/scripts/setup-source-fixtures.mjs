import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const postgresName = process.env.ASKLAKE_POSTGRES_CONTAINER || "asklake-postgres-source";
const postgresPort = process.env.ASKLAKE_SOURCE_PGPORT || "15432";
const postgresPassword = process.env.ASKLAKE_SOURCE_PGPASSWORD || "asklake";
const mongoName = process.env.ASKLAKE_MONGO_CONTAINER || "asklake-mongodb-source";
const mongoPort = process.env.ASKLAKE_MONGO_PORT || "27018";
const dockerNetwork = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

ensureDockerNetwork();
if (process.env.ASKLAKE_WITH_SOURCE_MINIO === "true") {
  ensureSourceMinio();
  await seedMinioSourceSamples();
}
ensurePostgres();
loadPostgresSample();
ensureMongo();
loadMongoSample();

if (process.env.ASKLAKE_WITH_KAFKA === "true") {
  ensureRedpanda();
  waitForRedpanda();
  loadKafkaSample();
}

console.log("source fixtures ready");

function ensurePostgres() {
  const inspect = run("docker", ["inspect", postgresName], { allowFailure: true, quiet: true });
  if (inspect.status !== 0) {
    run("docker", [
      "run",
      "-d",
      "--name",
      postgresName,
      "--network",
      dockerNetwork,
      "-p",
      `${postgresPort}:5432`,
      "-e",
      "POSTGRES_USER=asklake",
      "-e",
      `POSTGRES_PASSWORD=${postgresPassword}`,
      "-e",
      "POSTGRES_DB=asklake_sources",
      "postgres:16-alpine",
    ]);
  } else {
    run("docker", ["start", postgresName], { allowFailure: true, quiet: true });
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = run("docker", ["exec", postgresName, "pg_isready", "-U", "asklake", "-d", "asklake_sources"], { allowFailure: true, quiet: true });
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("Postgres fixture did not become ready.");
}

function loadPostgresSample() {
  const sql = `
create table if not exists public.nyc_taxi_sample (
  id integer primary key,
  event_time timestamptz not null,
  product_id bigint not null,
  price double precision not null,
  active boolean not null,
  payload jsonb not null,
  brand text
);
insert into public.nyc_taxi_sample(id, event_time, product_id, price, active, payload, brand) values
  (1, '2026-07-04T00:00:00Z', 100001, 12.75, true, '{"region":"KR"}', 'alpha'),
  (2, '2026-07-04T00:01:00Z', 100002, 31.40, false, '{"region":"US"}', 'beta')
on conflict (id) do update set price = excluded.price;
`;
  run("docker", ["exec", "-i", postgresName, "psql", "-U", "asklake", "-d", "asklake_sources"], { input: sql, quiet: true });
}

function ensureMongo() {
  const inspect = run("docker", ["inspect", mongoName], { allowFailure: true, quiet: true });
  if (inspect.status !== 0) {
    run("docker", [
      "run",
      "-d",
      "--name",
      mongoName,
      "--network",
      dockerNetwork,
      "-p",
      `${mongoPort}:27017`,
      "mongo:7",
    ]);
  } else {
    run("docker", ["start", mongoName], { allowFailure: true, quiet: true });
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = run("docker", ["exec", mongoName, "mongosh", "--quiet", "--eval", "db.adminCommand({ ping: 1 }).ok"], { allowFailure: true, quiet: true });
    if (ready.status === 0 && String(ready.stdout).includes("1")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("MongoDB fixture did not become ready.");
}

function loadMongoSample() {
  const script = `
const dbh = db.getSiblingDB("asklake_sources");
dbh.app_events.drop();
dbh.app_events.insertMany([
  {
    event_time: ISODate("2026-07-04T00:00:00Z"),
    user_id: "u_001",
    email: "alpha@example.com",
    active: true,
    amount: 42.7,
    profile: { city: "Seoul", age: 29 },
    tags: ["commerce", "mobile"],
    payload: { region: "KR", device: "android" }
  },
  {
    event_time: ISODate("2026-07-04T00:01:00Z"),
    user_id: "u_002",
    email: "beta@example.com",
    active: false,
    amount: 19.25,
    profile: { city: "Busan", age: 35 },
    tags: ["commerce"],
    payload: { region: "KR", device: "ios" }
  },
  {
    event_time: ISODate("2026-07-04T00:02:00Z"),
    user_id: "u_003",
    email: null,
    active: true,
    amount: 7,
    profile: { city: "New York" },
    tags: [],
    payload: { region: "US", device: "web" }
  }
]);
`;
  run("docker", ["exec", "-i", mongoName, "mongosh", "--quiet"], { input: script, quiet: true });
}

function ensureRedpanda() {
  const redpandaName = process.env.ASKLAKE_REDPANDA_CONTAINER || "asklake-redpanda-source";
  const inspect = run("docker", ["inspect", redpandaName], { allowFailure: true, quiet: true });
  if (inspect.status === 0 && process.env.ASKLAKE_RECREATE_KAFKA === "true") {
    run("docker", ["rm", "-f", redpandaName], { quiet: true });
  }

  const current = run("docker", ["inspect", redpandaName], { allowFailure: true, quiet: true });
  if (current.status !== 0) {
    run("docker", [
      "run",
      "-d",
      "--name",
      redpandaName,
      "--network",
      dockerNetwork,
      "-p",
      "19092:19092",
      "redpandadata/redpanda:v24.3.1",
      "redpanda",
      "start",
      "--overprovisioned",
      "--smp",
      "1",
      "--memory",
      "512M",
      "--reserve-memory",
      "0M",
      "--node-id",
      "0",
      "--check=false",
      "--kafka-addr",
      "internal://0.0.0.0:9092,external://0.0.0.0:19092",
      "--advertise-kafka-addr",
      `internal://${redpandaName}:9092,external://127.0.0.1:19092`,
    ]);
  } else {
    run("docker", ["start", redpandaName], { allowFailure: true, quiet: true });
  }
  console.log("Kafka fixture requested. If the image was not present, Docker may need time to pull/start Redpanda.");
}

function ensureDockerNetwork() {
  const inspect = run("docker", ["network", "inspect", dockerNetwork], { allowFailure: true, quiet: true });
  if (inspect.status !== 0) {
    run("docker", ["network", "create", dockerNetwork]);
  }
}

function ensureSourceMinio() {
  const minioName = process.env.ASKLAKE_SOURCE_MINIO_CONTAINER || "asklake-source-minio";
  const minioPort = process.env.ASKLAKE_SOURCE_MINIO_PORT || "19000";
  const consolePort = process.env.ASKLAKE_SOURCE_MINIO_CONSOLE_PORT || "19001";
  const inspect = run("docker", ["inspect", minioName], { allowFailure: true, quiet: true });
  if (inspect.status !== 0) {
    run("docker", [
      "run",
      "-d",
      "--name",
      minioName,
      "--network",
      dockerNetwork,
      "-p",
      `${minioPort}:9000`,
      "-p",
      `${consolePort}:9001`,
      "-e",
      "MINIO_ROOT_USER=m3admin",
      "-e",
      "MINIO_ROOT_PASSWORD=wishuponastar",
      "quay.io/minio/minio:latest",
      "server",
      "/data",
      "--console-address",
      ":9001",
    ]);
  } else {
    run("docker", ["start", minioName], { allowFailure: true, quiet: true });
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = run("docker", ["exec", minioName, "mc", "ready", "local"], { allowFailure: true, quiet: true });
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Source MinIO fixture did not become ready.");
}

function waitForRedpanda() {
  const redpandaName = process.env.ASKLAKE_REDPANDA_CONTAINER || "asklake-redpanda-source";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = run("docker", ["exec", redpandaName, "rpk", "cluster", "info", "--brokers", "127.0.0.1:9092"], { allowFailure: true, quiet: true });
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Redpanda fixture did not become ready.");
}

function loadKafkaSample() {
  const redpandaName = process.env.ASKLAKE_REDPANDA_CONTAINER || "asklake-redpanda-source";
  const topic = process.env.ASKLAKE_KAFKA_TOPIC || "asklake-source-events";
  run("docker", ["exec", redpandaName, "rpk", "topic", "delete", topic, "--brokers", "127.0.0.1:9092"], { allowFailure: true, quiet: true });
  run("docker", ["exec", redpandaName, "rpk", "topic", "create", topic, "--brokers", "127.0.0.1:9092"], { allowFailure: true, quiet: true });
  const messages = [
    { action: "view", amount: 42.7, event_time: "2026-07-04T00:00:00Z", event_id: "evt_001", payload: { device: "android", region: "KR" }, user_id: "u_001" },
    { action: "purchase", amount: 19.25, event_time: "2026-07-04T00:01:00Z", event_id: "evt_002", payload: { device: "ios", region: "KR" }, user_id: "u_002" },
    { action: "refund", amount: 7, event_time: "2026-07-04T00:02:00Z", event_id: "evt_003", payload: { device: "web", region: "US" }, user_id: "u_003" },
  ].map((message) => JSON.stringify(message)).join("\n");
  run("docker", ["exec", "-i", redpandaName, "rpk", "topic", "produce", topic, "--brokers", "127.0.0.1:9092", "--compression", "none"], { input: messages, quiet: true });
  console.log(`Kafka fixture topic ready: ${topic}`);
}

async function seedMinioSourceSamples() {
  const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
  const region = process.env.MINIO_REGION || "us-east-1";
  const bucket = process.env.MINIO_BUCKET || "m3-raw";
  const accessKeyId = process.env.MINIO_ACCESS_KEY || "m3admin";
  const secretAccessKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle: true,
    region,
  });
  await ensureBucket(client, bucket);
  const samples = [
    ["asklake-fixtures/csv/events.csv", "text/csv", "id,event_time,user_id,amount,active\n1,2026-07-04T00:00:00Z,u_001,42.7,true\n2,2026-07-04T00:01:00Z,u_002,19.25,false\n"],
    ["asklake-fixtures/json/events.json", "application/json", JSON.stringify([
      { active: true, amount: 42.7, event_time: "2026-07-04T00:00:00Z", id: 1, payload: { region: "KR" }, user_id: "u_001" },
      { active: false, amount: 19.25, event_time: "2026-07-04T00:01:00Z", id: 2, payload: { region: "US" }, user_id: "u_002" },
    ], null, 2)],
    ["asklake-fixtures/jsonl/events.jsonl", "application/x-ndjson", [
      JSON.stringify({ action: "view", amount: 42.7, event_time: "2026-07-04T00:00:00Z", event_id: "evt_001", user_id: "u_001" }),
      JSON.stringify({ action: "purchase", amount: 19.25, event_time: "2026-07-04T00:01:00Z", event_id: "evt_002", user_id: "u_002" }),
    ].join("\n")],
    ["asklake-fixtures/tsv/events.tsv", "text/tab-separated-values", "id\tevent_time\tuser_id\tamount\tactive\n1\t2026-07-04T00:00:00Z\tu_001\t42.7\ttrue\n2\t2026-07-04T00:01:00Z\tu_002\t19.25\tfalse\n"],
    ["asklake-fixtures/txt/events.txt", "text/plain", "2026-07-04T00:00:00Z u_001 view 42.7\n2026-07-04T00:01:00Z u_002 purchase 19.25\n"],
  ];

  for (const [key, contentType, body] of samples) {
    await client.send(new PutObjectCommand({ Body: body, Bucket: bucket, ContentType: contentType, Key: key }));
  }

  const parquetFixture = findFirstParquetFixture();
  if (parquetFixture) {
    await client.send(new PutObjectCommand({
      Body: readFileSync(parquetFixture),
      Bucket: bucket,
      ContentType: "application/octet-stream",
      Key: `asklake-fixtures/parquet/${path.basename(parquetFixture)}`,
    }));
  }
  console.log("MinIO source fixtures ready");
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

function findFirstParquetFixture() {
  const roots = [
    path.join(backendDir, "tmp", "spark-output"),
    path.join(backendDir, "tmp"),
  ];
  for (const root of roots) {
    const found = findFirstFile(root, (filePath) => filePath.toLowerCase().endsWith(".parquet"));
    if (found) return found;
  }
  return "";
}

function findFirstFile(root, predicate) {
  if (!existsSync(root)) return "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstFile(nextPath, predicate);
      if (found) return found;
    } else if (predicate(nextPath)) {
      return nextPath;
    }
  }
  return "";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  return result;
}
