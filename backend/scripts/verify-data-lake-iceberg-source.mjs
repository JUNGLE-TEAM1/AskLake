import assert from "node:assert/strict";

import { sparkSourceFromJob } from "../src/sparkRunner.mjs";

const previousCatalog = process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME;

try {
  process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME = "asklake";
  assert.deepEqual(
    sparkSourceFromJob({
      sourceConfig: [
        ["Source Dataset", "source_dataset"],
        ["Source Dataset ID", "ds_source_dataset"],
      ],
      sourceIcebergTable: {
        catalog: "iceberg",
        format: "iceberg",
        namespace: "asklake",
        table: "source_dataset_1234",
      },
      sourceType: "Data Lake",
    }, "run_data_lake"),
    {
      format: "iceberg",
      path: "asklake.asklake.source_dataset_1234",
    },
  );

  assert.deepEqual(
    sparkSourceFromJob({
      sourceConfig: [["Path", "s3://m3-raw/example/"]],
      sourceType: "Data Lake",
    }, "run_legacy_lake"),
    {
      format: "parquet",
      path: "s3a://m3-raw/example/",
    },
  );

  console.log("Data Lake Iceberg source verification passed.");
} finally {
  if (previousCatalog === undefined) delete process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME;
  else process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME = previousCatalog;
}
