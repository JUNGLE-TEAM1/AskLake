import { listModelArtifacts } from "../src/createPipeline.mjs";

try {
  const models = await listModelArtifacts();
  console.log(`ASKLAKE_TEXT_STRUCTURING_MODELS=${JSON.stringify({ models })}`);
} catch (error) {
  console.log(`ASKLAKE_TEXT_STRUCTURING_MODELS_ERROR=${JSON.stringify({
    code: error?.code || "TEXT_STRUCTURING_MODEL_LIST_FAILED",
    message: error?.message || "Text structuring model list failed.",
    status: error?.status || 500,
  })}`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
