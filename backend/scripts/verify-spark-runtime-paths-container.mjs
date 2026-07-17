import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeScript = path.join(backendDir, "scripts", "ensure_spark_runtime_paths.py");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "asklake-spark-runtime-container-"));
const containerName = `asklake-spark-runtime-guard-${process.pid}`;
const image = process.env.ASKLAKE_SPARK_BASE_IMAGE || "apache/spark:4.0.1";
const reportPath = path.join(temporaryRoot, "spark-runs", "existing-report.json");
const checkpointPath = path.join(temporaryRoot, "spark-runs", "checkpoints", "existing-checkpoint");

const commonArguments = [
  "-e", "ASKLAKE_SPARK_RUNTIME_ROOT=/var/lib/asklake",
  "-e", "ASKLAKE_SPARK_RUNTIME_UID=185",
  "-e", "ASKLAKE_SPARK_RUNTIME_GID=185",
  "-e", "ASKLAKE_SPARK_RUNTIME_DIRECTORY_MODE=2770",
  "-e", "ASKLAKE_SPARK_RUNTIME_FILE_MODE=0660",
  "-v", `${temporaryRoot}:/var/lib/asklake`,
  "-v", `${runtimeScript}:/runtime/ensure_spark_runtime_paths.py:ro`,
];

try {
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  writeFileSync(reportPath, '{"rows":17}\n');
  writeFileSync(checkpointPath, "offset=42\n");
  const reportBefore = readFileSync(reportPath);
  const checkpointBefore = readFileSync(checkpointPath);

  dockerRun(["run", "--rm", ...commonArguments, image, "python3", runtimeScriptInContainer(), "prepare"]);
  dockerRun([
    "run", "--rm", "--user", "185:185", ...commonArguments,
    image, "python3", runtimeScriptInContainer(), "check-writer",
  ]);
  dockerRun([
    "run", "--rm", "--user", "185:185", ...commonArguments,
    image, "python3", runtimeScriptInContainer(), "check-backend",
  ]);

  dockerRun([
    "run", "--rm", ...commonArguments, image, "python3", "-c",
    "import os; os.chown('/var/lib/asklake/spark-output', 0, 0); os.chmod('/var/lib/asklake/spark-runs', 0o700)",
  ]);
  dockerRun(["run", "--rm", ...commonArguments, image, "python3", runtimeScriptInContainer(), "prepare"]);

  dockerRun([
    "run", "-d", "--name", containerName, "--restart", "unless-stopped",
    "-e", "ASKLAKE_SPARK_RUNTIME_GUARD_INTERVAL_SECONDS=1",
    ...commonArguments,
    image, "python3", runtimeScriptInContainer(), "guard",
  ]);
  waitForContainer();
  dockerRun(["restart", containerName]);
  waitForContainer();
  waitForMetadata();

  assert.deepEqual(readFileSync(reportPath), reportBefore, "Existing report content must survive guard restarts.");
  assert.deepEqual(
    readFileSync(checkpointPath),
    checkpointBefore,
    "Existing checkpoint content must survive guard restarts.",
  );

  console.log(JSON.stringify({
    code: "spark_runtime_container_smoke_verified",
    image,
    scenarios: [
      "clean_bind_mount",
      "uid_185_writer_probe",
      "backend_read_probe",
      "wrong_owner_mode_repair",
      "guard_process_restart",
      "existing_data_preserved",
    ],
  }));
} finally {
  spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  spawnSync("docker", [
    "run", "--rm", "--user", "0:0",
    "-v", `${temporaryRoot}:/cleanup`,
    image,
    "python3", "-c",
    "import pathlib, shutil; root=pathlib.Path('/cleanup'); [shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink() for child in root.iterdir()]",
  ], { encoding: "utf8", timeout: 120_000 });
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function runtimeScriptInContainer() {
  return "/runtime/ensure_spark_runtime_paths.py";
}

function dockerRun(argumentsList) {
  const result = spawnSync("docker", argumentsList, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(
    result.status,
    0,
    `docker ${argumentsList.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function waitForContainer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerName], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0 && result.stdout.trim() === "true") return;
    sleep(200);
  }
  throw new Error(`Runtime guard container ${containerName} did not become running.`);
}

function waitForMetadata() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", [
      "exec", containerName, "python3", runtimeScriptInContainer(), "check-metadata",
    ], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0) return;
    sleep(200);
  }
  throw new Error(`Runtime guard container ${containerName} did not restore metadata.`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
