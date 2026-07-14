import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const requestedScript = process.argv[2];

if (!requestedScript) {
  console.error("Usage: node scripts/run-python-verification.mjs <script.py>");
  process.exit(2);
}

const localPythonCandidates = process.platform === "win32"
  ? [path.join(backendDir, ".venv", "Scripts", "python.exe")]
  : [path.join(backendDir, ".venv", "bin", "python")];
const localPython = localPythonCandidates.find((candidate) => existsSync(candidate));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON
  || localPython
  || (process.platform === "win32" ? "python" : "python3");
const scriptPath = path.resolve(backendDir, requestedScript);

if (!scriptPath.startsWith(`${path.resolve(backendDir, "scripts")}${path.sep}`)) {
  console.error("Verification scripts must stay inside backend/scripts.");
  process.exit(2);
}

const result = spawnSync(pythonBin, [scriptPath], {
  cwd: backendDir,
  env: {
    ...process.env,
    PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  stdio: "inherit",
});

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
