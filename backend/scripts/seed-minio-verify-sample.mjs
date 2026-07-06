import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const region = process.env.MINIO_REGION || "us-east-1";
const accessKeyId = process.env.MINIO_ACCESS_KEY || "m3admin";
const secretAccessKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
const bucket = process.env.MINIO_BUCKET || "m3-raw";
const key = process.env.ASKLAKE_VERIFY_MINIO_OBJECT || "nyc_taxi/csv/2019-Nov.csv";

const client = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region,
});

await waitForMinio();
await ensureBucket();
await client.send(new PutObjectCommand({
  Body: [
    "vendor_id,pickup_datetime,dropoff_datetime,passenger_count,trip_distance,total_amount,payment_type",
    "1,2026-07-04T00:00:00Z,2026-07-04T00:12:00Z,1,3.4,18.75,card",
    "2,2026-07-04T00:05:00Z,2026-07-04T00:19:00Z,2,5.1,27.40,cash",
    "1,2026-07-04T00:09:00Z,2026-07-04T00:22:00Z,1,2.6,15.20,card",
  ].join("\n"),
  Bucket: bucket,
  ContentType: "text/csv",
  Key: key,
}));

console.log(`MinIO verify sample ready: s3://${bucket}/${key}`);

async function waitForMinio() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return;
      await sleep(250);
    }
  }
  throw new Error(`MinIO did not become reachable at ${endpoint}.`);
}

async function ensureBucket() {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const alreadyExists = ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error?.name);
    if (!alreadyExists) throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
