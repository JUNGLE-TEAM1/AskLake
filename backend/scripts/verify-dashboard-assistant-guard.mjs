import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const localPython = path.join(backendDir, ".venv", "bin", "python");
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || (existsSync(localPython) ? localPython : "python3");
const scriptPath = path.join(backendDir, "scripts", "verify-dashboard-assistant-guard.py");

const result = spawnSync(pythonBin, [scriptPath], {
  cwd: backendDir,
  env: {
    ...process.env,
    PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
