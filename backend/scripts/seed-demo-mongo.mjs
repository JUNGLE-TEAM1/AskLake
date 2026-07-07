import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";

const fixturePath = process.env.ASKLAKE_MONGO_FIXTURE_PATH
  || new URL("../app/seed/demo_mongo_fixture.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const shouldDelete = process.argv.includes("--delete");

const database = process.env.ASKLAKE_MONGO_DATABASE || process.env.MONGO_INITDB_DATABASE || "asklake_sources";
const uri = process.env.ASKLAKE_MONGO_URL || buildMongoUri({ database });
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });

try {
  await client.connect();
  const db = client.db(database);
  const summaries = [];

  for (const collectionFixture of fixture.collections) {
    const collection = db.collection(collectionFixture.collection);
    const uniqueKey = collectionFixture.uniqueKey;
    const uniqueValues = collectionFixture.documents.map((document) => document[uniqueKey]).filter(Boolean);
    if (uniqueValues.length === 0) {
      throw new Error(`${collectionFixture.collection} fixture has no ${uniqueKey} values.`);
    }

    await collection.createIndex({ [uniqueKey]: 1 }, { unique: true });
    if (collectionFixture.collection === "customer_reviews") await collection.createIndex({ customerId: 1 });
    if (collectionFixture.collection === "app_events") await collection.createIndex({ customerId: 1, eventTime: -1 });

    if (shouldDelete) {
      const result = await collection.deleteMany({ [uniqueKey]: { $in: uniqueValues } });
      summaries.push({ collection: collectionFixture.collection, deleted: result.deletedCount });
      continue;
    }

    for (const rawDocument of collectionFixture.documents) {
      const document = coerceMongoDocument(rawDocument);
      await collection.replaceOne({ [uniqueKey]: document[uniqueKey] }, document, { upsert: true });
    }
    const count = await collection.countDocuments({ [uniqueKey]: { $in: uniqueValues } });
    summaries.push({ collection: collectionFixture.collection, upsertedFixtureCount: count });
  }

  console.log(JSON.stringify({ database, mode: shouldDelete ? "delete" : "seed", summaries }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}

function buildMongoUri({ database }) {
  const host = process.env.ASKLAKE_MONGO_HOST || "127.0.0.1";
  const port = process.env.ASKLAKE_MONGO_PORT || "27017";
  const user = process.env.ASKLAKE_MONGO_USER || process.env.MONGO_INITDB_ROOT_USERNAME || "";
  const password = process.env.ASKLAKE_MONGO_PASSWORD || process.env.MONGO_INITDB_ROOT_PASSWORD || "";
  const authSource = process.env.ASKLAKE_MONGO_AUTH_SOURCE || "admin";
  const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  const authQuery = user ? `?authSource=${encodeURIComponent(authSource)}` : "";
  return `mongodb://${authPart}${host}:${port}/${database}${authQuery}`;
}

function coerceMongoDocument(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => coerceMongoDocument(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, coerceMongoDocument(childValue, childKey)]),
    );
  }
  if (typeof value === "string" && /(?:At|Time)$/.test(key) && !Number.isNaN(Date.parse(value))) {
    return new Date(value);
  }
  return value;
}
