import http from "node:http";
import {
  commandJob,
  createTextStructuringTrainingRun,
  createPipeline,
  executeQuery,
  getPipelineJob,
  getPipelineRun,
  listDatasets,
  listJobs,
  listModelArtifacts,
  previewDatasetRows,
  readPipelineRunLogs,
} from "./createPipeline.mjs";
import { listSourceAssets, testSourceConnector } from "./connectors.mjs";
import { listS3Buckets, listS3Prefixes } from "./s3.service.mjs";
import { ensureMetadataSchema, resetMetadata } from "./metadataStore.mjs";
import { listTargetDatabases } from "./targetDatabase.service.mjs";
import { getCellphonesReviewAnalysisStatus, runCellphonesReviewAnalysis, suggestReviewAnalysisSchema } from "./reviewRowAnalysis.mjs";
import { handleAuthRoute } from "./authService.mjs";
import { compileRuleContract } from "./ruleCompiler.mjs";
import { applySnapshotRules, supportsSnapshotRules } from "./snapshotRuleRuntime.mjs";
import { kafkaDefaultBroker } from "./kafkaRuntime.mjs";

const port = Number(process.env.PORT || 8080);

const server = http.createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  response.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || requestOrigin || "*");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "asklake-backend", time: new Date().toISOString() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/etl/sources/defaults") {
      sendJson(response, 200, {
        kafkaBroker: kafkaDefaultBroker(),
      });
      return;
    }

    if (await handleAuthRoute(request, response, url, readJson, sendJson)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/etl/jobs") {
      sendJson(response, 200, await listJobs({
        lastRunOutcome: url.searchParams.get("lastRunOutcome") || undefined,
        owner: url.searchParams.get("owner") || undefined,
        scheduleKind: url.searchParams.get("scheduleKind") || undefined,
        statuses: url.searchParams.getAll("status"),
      }));
      return;
    }

    if (request.method === "GET" && /^\/api\/etl\/jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[4]);
      sendJson(response, 200, await getPipelineJob(jobId));
      return;
    }

    if (request.method === "GET" && /^\/api\/etl\/jobs\/[^/]+\/runs\/[^/]+$/.test(url.pathname)) {
      const segments = url.pathname.split("/");
      const jobId = decodeURIComponent(segments[4]);
      const runId = decodeURIComponent(segments[6]);
      sendJson(response, 200, await getPipelineRun(jobId, runId));
      return;
    }

    if (request.method === "GET" && /^\/api\/etl\/jobs\/[^/]+\/runs\/[^/]+\/logs$/.test(url.pathname)) {
      const segments = url.pathname.split("/");
      const jobId = decodeURIComponent(segments[4]);
      const runId = decodeURIComponent(segments[6]);
      const stream = url.searchParams.get("stream") || "stdout";
      const tailBytes = Number(url.searchParams.get("tail") || 65536);
      sendJson(response, 200, await readPipelineRunLogs(jobId, runId, { stream, tailBytes }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/datasets") {
      sendJson(response, 200, await listDatasets());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/models") {
      sendJson(response, 200, await listModelArtifacts());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/text-structuring/models") {
      sendJson(response, 200, await listModelArtifacts());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/text-structuring/training-runs") {
      const body = await readJson(request);
      sendJson(response, 201, await createTextStructuringTrainingRun(body));
      return;
    }

    if (request.method === "GET" && /^\/api\/catalog\/datasets\/[^/]+\/rows$/.test(url.pathname)) {
      const datasetId = decodeURIComponent(url.pathname.split("/")[4]);
      sendJson(response, 200, await previewDatasetRows(datasetId, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/s3/buckets") {
      sendJson(response, 200, listS3Buckets());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/s3/prefixes") {
      sendJson(response, 200, await listS3Prefixes({
        bucket: url.searchParams.get("bucket") ?? "",
        continuationToken: url.searchParams.get("continuationToken"),
        prefix: url.searchParams.get("prefix") ?? "",
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/target/databases") {
      sendJson(response, 200, listTargetDatabases());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/review-analysis/cellphones") {
      sendJson(response, 200, await getCellphonesReviewAnalysisStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-analysis/cellphones/run") {
      const body = await readJson(request);
      sendJson(response, 200, await runCellphonesReviewAnalysis(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-analysis/schema-suggestion") {
      const body = await readJson(request);
      sendJson(response, 200, await suggestReviewAnalysisSchema(body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/harness/rest-sample") {
      sendJson(response, 200, {
        data: [
          { active: true, amount: 42.7, event_time: "2026-07-04T10:00:00Z", id: 1, payload: { region: "KR" }, user_id: "u_001" },
          { active: false, amount: 19.25, event_time: "2026-07-04T10:01:00Z", id: 2, payload: { region: "US" }, user_id: "u_002" },
        ],
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/etl/sources/test") {
      const body = await readJson(request);
      const sourceType = body.sourceType;
      const sourceConfig = Array.isArray(body.sourceConfig) ? body.sourceConfig : [];
      sendJson(response, 200, await testSourceConnector(sourceType, sourceConfig));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/etl/sources/assets") {
      const body = await readJson(request);
      const sourceType = body.sourceType;
      const sourceConfig = Array.isArray(body.sourceConfig) ? body.sourceConfig : [];
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      sendJson(response, 200, await listSourceAssets(sourceType, sourceConfig, prefix));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/etl/schema-inference") {
      const body = await readJson(request);
      const sourceType = body.sourceType;
      const sourceConfig = Array.isArray(body.sourceConfig) ? body.sourceConfig : [];
      const result = await testSourceConnector(sourceType, sourceConfig);
      sendJson(response, 200, result.draftPatch.schema ?? {});
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/etl/rules/preview") {
      const body = await readJson(request);
      const compilation = compileRuleContract({
        executionMode: body.executionMode || "snapshot",
        ruleContractVersion: body.ruleContractVersion,
        rules: Array.isArray(body.rules) ? body.rules : [],
        schemaColumns: Array.isArray(body.schemaColumns) ? body.schemaColumns : [],
        sourceType: body.sourceType || "",
      });
      if (compilation.status !== "pass") {
        throw Object.assign(new Error(compilation.issues[0]?.message || "Rule compilation failed."), {
          code: "RULE_COMPILATION_FAILED",
          details: { issues: compilation.issues },
          status: 400,
        });
      }
      if (!supportsSnapshotRules(compilation.rules)) {
        throw Object.assign(new Error("Preview supports canonical Snapshot operations only."), {
          code: "RULE_PREVIEW_OPERATION_UNSUPPORTED",
          status: 422,
        });
      }
      const records = Array.isArray(body.records) ? body.records.slice(0, 100) : [];
      sendJson(response, 200, {
        compilation,
        ...applySnapshotRules(records, compilation.rules),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/etl/jobs") {
      const body = await readJson(request);
      sendJson(response, 201, await createPipeline(body));
      return;
    }

    if (request.method === "POST" && /^\/api\/etl\/jobs\/[^/]+\/commands$/.test(url.pathname)) {
      const body = await readJson(request);
      const jobId = decodeURIComponent(url.pathname.split("/")[4]);
      sendJson(response, 200, await commandJob(jobId, body.command));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/query/runs") {
      const body = await readJson(request);
      sendJson(response, 200, await executeQuery(body));
      return;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: `No route for ${request.method} ${url.pathname}` } });
  } catch (error) {
    const status = Number(error.status || 500);
    const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    sendJson(response, status, {
      error: {
        code,
        ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
        message: error.message || "Internal server error",
      },
    });
  }
});

async function startServer() {
  await ensureMetadataSchema();
  if (process.env.ASKLAKE_RESET_METADATA_ON_START === "true") {
    await resetMetadata();
  }
  server.listen(port, () => {
    console.log(`AskLake backend listening on http://localhost:${port}`);
    console.log("AskLake metadata DB ready.");
  });
}

startServer().catch((error) => {
  console.error("AskLake backend failed to start.", error);
  process.exit(1);
});

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(Object.assign(new Error("Request body is too large."), { code: "BODY_TOO_LARGE", status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { code: "INVALID_JSON", status: 400 }));
      }
    });
    request.on("error", reject);
  });
}
