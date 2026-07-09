import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";

const result = spawnSync(pythonBin, ["scripts/verify-target-metadata-contract.py"], {
  cwd: backendDir,
  env: {
    ...process.env,
    PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;
