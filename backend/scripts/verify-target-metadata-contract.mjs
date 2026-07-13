import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const localPython = path.join(backendDir, ".venv", "bin", "python");
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || (existsSync(localPython) ? localPython : "python3");

const result = spawnSync(pythonBin, ["scripts/verify-target-metadata-contract.py"], {
  cwd: backendDir,
  env: {
    ...process.env,
    PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;
