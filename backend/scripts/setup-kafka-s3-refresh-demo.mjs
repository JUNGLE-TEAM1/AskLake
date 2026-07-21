import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Kafka } from "kafkajs";

import { DEMO_BUCKET, DEMO_KEY, DEMO_TOPIC } from "./kafka-s3-refresh-demo-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(scriptDir, "../fixtures/kafka-s3-refresh-demo/products.csv");
const broker = process.env.ASKLAKE_DEMO_KAFKA_BROKER || "127.0.0.1:19092";
const topic = process.env.ASKLAKE_DEMO_KAFKA_TOPIC || DEMO_TOPIC;
const endpoint = process.env.ASKLAKE_DEMO_S3_ENDPOINT || "http://127.0.0.1:9000";
const bucket = process.env.ASKLAKE_DEMO_S3_BUCKET || DEMO_BUCKET;
const key = process.env.ASKLAKE_DEMO_S3_KEY || DEMO_KEY;
const accessKeyId = process.env.ASKLAKE_DEMO_S3_ACCESS_KEY || "m3admin";
const secretAccessKey = process.env.ASKLAKE_DEMO_S3_SECRET_KEY || "wishuponastar";
const recreateTopic = process.argv.includes("--keep-topic") === false;

const s3 = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region: "us-east-1",
});
const kafka = new Kafka({ brokers: [broker], clientId: "asklake-kafka-s3-demo-setup" });
const admin = kafka.admin();

try {
  await ensureBucket();
  await s3.send(new PutObjectCommand({
    Body: await readFile(fixturePath),
    Bucket: bucket,
    ContentType: "text/csv; charset=utf-8",
    Key: key,
  }));

  await admin.connect();
  if (recreateTopic) {
    const topics = await admin.listTopics();
    if (topics.includes(topic)) {
      await admin.deleteTopics({ topics: [topic], timeout: 10000 });
    }
  }
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });

  console.log("Kafka + S3 JOIN demo fixture ready");
  console.log(`Kafka broker: ${broker}`);
  console.log(`Kafka topic: ${topic}`);
  console.log(`S3 endpoint: ${endpoint}`);
  console.log(`S3 object: s3://${bucket}/${key}`);
} finally {
  await admin.disconnect().catch(() => {});
  s3.destroy();
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
