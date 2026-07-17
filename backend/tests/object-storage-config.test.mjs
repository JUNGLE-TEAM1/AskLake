import assert from "node:assert/strict";
import test from "node:test";

import {
  validateConfiguredBucket,
  validateConfiguredS3Location,
} from "../src/objectStorageConfig.mjs";

test("deployment placeholders are rejected as storage buckets", () => {
  assert.throws(
    () => validateConfiguredBucket("replace-with-asklake-warehouse-bucket", "warehouse"),
    /placeholder/,
  );
});

test("a real MinIO warehouse bucket is accepted", () => {
  assert.equal(
    validateConfiguredBucket("asklake-warehouse", "warehouse"),
    "asklake-warehouse",
  );
});

test("configured warehouse locations validate and normalize their bucket", () => {
  assert.equal(
    validateConfiguredS3Location("s3a://asklake-warehouse/warehouse/", "warehouse"),
    "s3a://asklake-warehouse/warehouse",
  );
  assert.throws(
    () => validateConfiguredS3Location("s3a://replace-with-bucket/warehouse", "warehouse"),
    /placeholder/,
  );
});
