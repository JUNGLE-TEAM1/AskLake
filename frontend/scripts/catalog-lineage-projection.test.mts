import assert from "node:assert/strict";
import test from "node:test";

import { collapseProcessLineageGraph } from "../src/pages/catalog/catalogLineageProjection.ts";
import type { LineageGraph } from "../src/types/catalog.ts";

function lineageFixture(): LineageGraph {
  return {
    datasetId: "target",
    datasets: [
      {
        columns: [{ id: "source-text", name: "text", type: "string" }],
        engine: "PARQUET",
        id: "source",
        layer: "SOURCE",
        name: "reviews.parquet",
      },
      {
        columns: [
          { id: "job-text", name: "text", type: "string" },
          { id: "job-sentiment", name: "sentiment", type: "string" },
          { id: "job-run", name: "_asklake_run_id", type: "string" },
        ],
        engine: "SPARK",
        id: "job",
        layer: "PROCESS",
        name: "review enrichment",
      },
      {
        columns: [
          { id: "target-text", name: "text", type: "string" },
          { id: "target-sentiment", name: "sentiment", type: "string" },
          { id: "target-run", name: "_asklake_run_id", type: "string" },
        ],
        engine: "PARQUET",
        id: "target",
        layer: "GOLD",
        name: "review_gold",
      },
    ],
    edges: [
      { fromColumnId: "source-text", fromDatasetId: "source", toColumnId: "job-text", toDatasetId: "job" },
      { fromColumnId: "source-text", fromDatasetId: "source", toColumnId: "job-sentiment", toDatasetId: "job" },
      { fromColumnId: "job-text", fromDatasetId: "job", toColumnId: "target-text", toDatasetId: "target" },
      { fromColumnId: "job-sentiment", fromDatasetId: "job", toColumnId: "target-sentiment", toDatasetId: "target" },
      { fromColumnId: "job-run", fromDatasetId: "job", toColumnId: "target-run", toDatasetId: "target" },
    ],
  };
}

test("Catalog lineage hides PROCESS nodes and bridges matching columns", () => {
  const source = lineageFixture();
  const projected = collapseProcessLineageGraph(source);

  assert.deepEqual(projected.datasets.map((dataset) => dataset.id), ["source", "target"]);
  assert.deepEqual(projected.edges, [
    { fromColumnId: "source-text", fromDatasetId: "source", toColumnId: "target-text", toDatasetId: "target" },
    { fromColumnId: "source-text", fromDatasetId: "source", toColumnId: "target-sentiment", toDatasetId: "target" },
  ]);
  assert.equal(source.datasets.length, 3, "the persisted API graph must not be mutated");
  assert.equal(source.edges.length, 5, "the persisted edge list must remain intact");
});

test("Catalog lineage leaves graphs without PROCESS nodes unchanged", () => {
  const source = lineageFixture();
  const graph = {
    ...source,
    datasets: source.datasets.filter((dataset) => dataset.layer !== "PROCESS"),
    edges: [],
  };

  assert.equal(collapseProcessLineageGraph(graph), graph);
});
