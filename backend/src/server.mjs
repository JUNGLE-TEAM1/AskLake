import http from "node:http";
import { commandJob, createPipeline, executeQuery, getPipelineJob, listDatasets, listJobs } from "./createPipeline.mjs";
import { listSourceAssets, testSourceConnector } from "./connectors.mjs";
import { ensureMetadataSchema, resetMetadata } from "./metadataStore.mjs";

const port = Number(process.env.PORT || 8080);

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
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

    if (request.method === "GET" && url.pathname === "/api/etl/jobs") {
      sendJson(response, 200, await listJobs());
      return;
    }

    if (request.method === "GET" && /^\/api\/etl\/jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[4]);
      sendJson(response, 200, await getPipelineJob(jobId));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/catalog/datasets") {
      sendJson(response, 200, await listDatasets());
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
