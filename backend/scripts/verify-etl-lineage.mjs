import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const scriptPath = fileURLToPath(new URL("./verify-etl-lineage.py", import.meta.url));
const result = spawnSync(pythonBin, [scriptPath], { stdio: "inherit" });

if (result.error) {
  console.error(`Lineage verification could not start ${pythonBin}: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
