import { readFileSync } from "node:fs";
import { createTextStructuringTrainingRun } from "../src/createPipeline.mjs";

try {
  const request = JSON.parse(readFileSync(0, "utf8") || "{}");
  const result = await createTextStructuringTrainingRun(request);
  console.log(`ASKLAKE_TEXT_STRUCTURING_TRAINING_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_TEXT_STRUCTURING_TRAINING_ERROR=${JSON.stringify({
    code: error?.code || "TEXT_STRUCTURING_TRAINING_FAILED",
    message: error?.message || "Text structuring model training failed.",
    status: error?.status || 500,
  })}`);
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
