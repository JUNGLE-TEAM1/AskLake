import process from "node:process";

const PROTOCOL_VERSION = "1.0";

function redact(value) {
  return String(value ?? "")
    .replace(/(password|secret|token|access[_-]?key|authorization)(\s*[=:]\s*|"\s*:\s*")([^\s",}]+)/gi, "$1$2[REDACTED]")
    .slice(0, 4000);
}

function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request envelope must be an object");
  if (value.version !== PROTOCOL_VERSION) throw new Error("unsupported protocol version");
  if (typeof value.requestId !== "string" || !value.requestId.trim()) throw new Error("requestId is required");
  if (typeof value.idempotencyKey !== "string" || !value.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (typeof value.operation !== "string" || !value.operation.trim()) throw new Error("operation is required");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("payload must be an object");
  return value;
}

async function execute(operation, payload) {
  if (!["reviewAnalysis.suggestSchema", "reviewAnalysis.run"].includes(operation)) {
    throw new Error(`unsupported operation: ${operation}`);
  }
  const analysis = await import("../src/reviewRowAnalysis.mjs");
  if (operation === "reviewAnalysis.suggestSchema") return analysis.suggestReviewAnalysisSchema(payload);
  if (operation === "reviewAnalysis.run") return analysis.runCellphonesReviewAnalysis(payload);
}

let requestId = "unknown";
try {
  if (process.env.ASKLAKE_NODE_BRIDGE_VERSION && process.env.ASKLAKE_NODE_BRIDGE_VERSION !== PROTOCOL_VERSION) {
    throw new Error("runtime bridge version conflicts with the Node protocol");
  }
  const raw = await new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
  const envelope = validateEnvelope(JSON.parse(raw));
  requestId = envelope.requestId;
  const result = await execute(envelope.operation, envelope.payload);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("operation result must be an object");
  process.stdout.write(JSON.stringify({ version: PROTOCOL_VERSION, requestId, ok: true, result }));
} catch (error) {
  const message = redact(error?.message || error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(JSON.stringify({
    version: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: "NODE_OPERATION_FAILED", message },
  }));
  process.exitCode = 1;
}
