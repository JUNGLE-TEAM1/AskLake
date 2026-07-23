#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
INPUT_DIR="$TEMP_DIR/input"
EVIDENCE="$TEMP_DIR/evidence.json"
mkdir -p "$INPUT_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

if grep -Eq 'kubectl[[:space:]]+(apply|create|delete|patch|replace|scale)|helm[[:space:]]+(install|upgrade|uninstall)' \
  "$ROOT_DIR/scripts/capture-eks-day17-autoscaling-evidence.sh"; then
  echo "autoscaling observer contains a Kubernetes mutation command" >&2
  exit 1
fi

write_fixtures() {
  local deployment_generation="$1"
  local controlled_active="$2"
  rm -f "$INPUT_DIR/existing-evidence.json" "$INPUT_DIR/transition-proof.json" "$INPUT_DIR/smoke-release-values.json"
  node - "$INPUT_DIR" "$deployment_generation" "$controlled_active" <<'NODE'
const fs = require("fs");
const [directory, generation, controlledActive] = process.argv.slice(2);
const write = (name, value) => fs.writeFileSync(`${directory}/${name}`, `${JSON.stringify(value)}\n`);
const requirement = (key, operator, values) => ({ key, operator, values });
const pool = (name, values, categories, gt, limits, consolidationPolicy, consolidateAfter, terminationGracePeriod, tainted) => ({
  metadata: { name: `asklake-${name}` },
  spec: {
    template: {
      metadata: { labels: { "asklake.io/workload-class": name } },
      spec: {
        requirements: [
          requirement("kubernetes.io/arch", "In", ["amd64"]),
          requirement("karpenter.sh/capacity-type", "In", values),
          requirement("eks.amazonaws.com/instance-category", "In", categories),
          requirement("eks.amazonaws.com/instance-generation", "Gt", [String(gt)]),
        ],
        expireAfter: "480h",
        terminationGracePeriod,
        taints: tainted ? [{ key: "asklake.io/workload-class", value: "spark", effect: "NoSchedule" }] : [],
      },
    },
    limits,
    disruption: { consolidationPolicy, consolidateAfter, budgets: [{ nodes: "25%" }] },
  },
  status: { conditions: [{ type: "Ready", status: "True" }] },
});
write("nodepools.json", { items: [
  pool("general", ["on-demand"], ["m"], 5, { cpu: "8", memory: "32Gi" }, "WhenEmptyOrUnderutilized", "5m", "30m", false),
  pool("spark", ["spot", "on-demand"], ["m", "r"], 5, { cpu: "16", memory: "64Gi" }, "WhenEmpty", "10m", "2h", true),
] });
write("auto-mode-values.json", {
  general: { capacityTypes: ["on-demand"], instanceCategories: ["m"], instanceGenerationMin: 6, limits: { cpu: "8", memory: "32Gi" }, disruption: { consolidationPolicy: "WhenEmptyOrUnderutilized", consolidateAfter: "5m", budget: "25%" }, expireAfter: "480h", terminationGracePeriod: "30m" },
  spark: { capacityTypes: ["spot", "on-demand"], instanceCategories: ["m", "r"], instanceGenerationMin: 6, limits: { cpu: "16", memory: "64Gi" }, disruption: { consolidationPolicy: "WhenEmpty", consolidateAfter: "10m", budget: "25%" }, expireAfter: "480h", terminationGracePeriod: "2h" },
});
write("nodes.json", { items: [
  { metadata: { name: "node-private-a", labels: { "karpenter.sh/nodepool": "asklake-general" } }, status: { allocatable: { cpu: "2", memory: "8Gi" } } },
  { metadata: { name: "node-private-b", labels: { "karpenter.sh/nodepool": "asklake-spark" } }, spec: { taints: [{ key: "asklake.io/workload-class", value: "spark", effect: "NoSchedule" }] }, status: { allocatable: { cpu: "4", memory: "16Gi" } } },
] });
const pod = (name, node, labels = { app: name }, run = undefined) => ({
  metadata: { name: `${name}-private-pod`, uid: `${name}-private-uid`, labels: { ...labels, ...(run ? { "asklake.io/day17-run": run } : {}) } },
  spec: { nodeName: node, containers: [{ resources: { requests: { cpu: "250m", memory: "512Mi" } } }] },
  status: { phase: "Running" },
});
const namespacePods = [pod("fastapi", "node-private-a"), pod("spark", "node-private-b", { app: "spark" }, controlledActive === "true" ? "686ba49feabc4a99" : undefined)];
write("pods.json", { items: namespacePods });
const externalPod = {
  metadata: { name: "external-private-pod", uid: "external-private-uid", namespace: "other-namespace", labels: { app: "external" } },
  spec: {
    nodeName: "node-private-a",
    overhead: { cpu: "100m", memory: "16Mi" },
    containers: [{ resources: { requests: { cpu: "100u", memory: "1M" } } }],
  },
  status: { phase: "Running" },
};
write("allpods.json", { items: [...namespacePods, externalPod] });
write("deployments.json", { items: [{
  metadata: { name: "fastapi", uid: "fastapi-deployment-uid", generation: Number(generation) },
  spec: { selector: { matchLabels: { app: "fastapi" } }, template: { spec: { nodeSelector: { "asklake.io/workload-class": "general" } } } },
  status: { observedGeneration: Number(generation) },
}] });
write("hpas.json", { items: [{ metadata: { name: "fastapi", generation: 1 }, spec: { minReplicas: 2, maxReplicas: 6, metrics: [{ resource: { name: "cpu", target: { averageUtilization: 60 } } }] }, status: { currentReplicas: 2, desiredReplicas: 2 } }] });
write("jobs.json", { items: [] });
write("sparkapplications.json", { items: [] });
  write("endpointslices.json", { items: [{ endpoints: [{ conditions: { ready: true, terminating: false } }] }] });
  write("events.json", { items: [] });
write("helm-releases.json", [{ name: "asklake-web", namespace: "asklake-dev", revision: "1", chart: "asklake-web-0.3.0", status: "deployed" }]);
NODE
}

export ASKLAKE_EKS_NAMESPACE=asklake-dev
write_fixtures 1 false
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$EVIDENCE" baseline
[[ "$(stat -f '%Lp' "$EVIDENCE" 2>/dev/null || stat -c '%a' "$EVIDENCE")" == "600" ]]
node - "$EVIDENCE" <<'NODE'
const fs = require("fs");
const evidence = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const snapshot = evidence.snapshots[0];
if (!snapshot.gates.poolReady || !snapshot.gates.placementReady || !snapshot.gates.exclusiveWindowReady) process.exit(1);
if (snapshot.capacity.general.nodes !== 1 || snapshot.workloadRequests.general.requests.cpuMillicores !== 350) process.exit(1);
if (snapshot.capacity.general.maxSingleNodeFree.cpuMillicores !== 1650) process.exit(1);
const raw = fs.readFileSync(process.argv[2], "utf8");
if (raw.includes("node-private") || raw.includes("pod-private") || raw.includes("test-run-token")) process.exit(1);
NODE

cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
node - "$INPUT_DIR/hpas.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.items[0].status.currentReplicas = 4;
value.items[0].status.desiredReplicas = 4;
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/hpa-status-evidence.json" sample
node - "$TEMP_DIR/hpa-status-evidence.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.snapshots.at(-1).identityMatchesBaseline !== true) process.exit(1);
NODE

cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
write_fixtures 2 false
cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$EVIDENCE" sample
node - "$EVIDENCE" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.snapshots.at(-1).identityMatchesBaseline !== false) process.exit(1);
NODE

write_fixtures 2 false
cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$EVIDENCE" final
node - "$EVIDENCE" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (!evidence.cleanup.verified) process.exit(1);
NODE

write_fixtures 2 true
cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/unclean.json" final
node - "$TEMP_DIR/unclean.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.cleanup.verified) process.exit(1);
NODE

write_fixtures 2 false
node - "$INPUT_DIR" <<'NODE'
const fs = require("fs");
const directory = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(`${directory}/${name}`, "utf8"));
const write = (name, value) => fs.writeFileSync(`${directory}/${name}`, `${JSON.stringify(value)}\n`);
const pods = read("pods.json");
pods.items.push({ metadata: { name: "completed-private-pod", uid: "completed-private-uid", labels: { "asklake.io/day17-run": "686ba49feabc4a99" } }, spec: { containers: [] }, status: { phase: "Succeeded" } });
write("pods.json", pods);
const deployments = read("deployments.json");
deployments.items.push({ metadata: { name: "zero-private-deployment", uid: "zero-private-uid", generation: 1, labels: { "asklake.io/day17-run": "686ba49feabc4a99" } }, spec: { replicas: 0, selector: { matchLabels: { app: "zero" } }, template: { spec: {} } }, status: {} });
write("deployments.json", deployments);
NODE
cp "$EVIDENCE" "$INPUT_DIR/existing-evidence.json"
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/residue.json" final
node - "$TEMP_DIR/residue.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.cleanup.verified || evidence.cleanup.controlledResources.podsTotal !== 1 || evidence.cleanup.controlledResources.deploymentsTotal !== 1) process.exit(1);
NODE

write_fixtures 1 false
node - "$INPUT_DIR" <<'NODE'
const fs = require("fs");
const directory = process.argv[2];
const releases = JSON.parse(fs.readFileSync(`${directory}/helm-releases.json`, "utf8"));
releases.push({ name: "asklake-day17-nodepool-smoke", namespace: "asklake-dev", revision: "1", chart: "asklake-day17-nodepool-smoke-0.1.0", status: "deployed" });
fs.writeFileSync(`${directory}/helm-releases.json`, `${JSON.stringify(releases)}\n`);
fs.writeFileSync(`${directory}/smoke-release-values.json`, '{"runFingerprint":"ffffffffffffffff"}\n');
NODE
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/stale-release.json" baseline
node - "$TEMP_DIR/stale-release.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.snapshots[0].blockers.unexpectedSmokeRelease !== 1 || evidence.snapshots[0].gates.exclusiveWindowReady) process.exit(1);
NODE

write_fixtures 1 false
node - "$INPUT_DIR/hpas.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.items.push({ metadata: { name: "secondary", generation: 1 }, spec: { minReplicas: 1, maxReplicas: 2, metrics: [] }, status: { currentReplicas: 1, desiredReplicas: 1 } });
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/hpa-order.json" baseline
cp "$TEMP_DIR/hpa-order.json" "$INPUT_DIR/existing-evidence.json"
node - "$INPUT_DIR/hpas.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.items.reverse();
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/hpa-order.json" sample
node - "$TEMP_DIR/hpa-order.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (!evidence.snapshots.at(-1).identityMatchesBaseline) process.exit(1);
NODE

write_fixtures 1 false
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/unattributed-scale.json" baseline
cp "$TEMP_DIR/unattributed-scale.json" "$INPUT_DIR/existing-evidence.json"
node - "$INPUT_DIR/nodes.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.items.push(
  { metadata: { name: "unrelated-general-node", labels: { "karpenter.sh/nodepool": "asklake-general" } }, status: { allocatable: { cpu: "2", memory: "8Gi" } } },
  { metadata: { name: "unrelated-spark-node", labels: { "karpenter.sh/nodepool": "asklake-spark" } }, status: { allocatable: { cpu: "4", memory: "16Gi" } } },
);
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/unattributed-scale.json" sample
write_fixtures 1 false
cp "$TEMP_DIR/unattributed-scale.json" "$INPUT_DIR/existing-evidence.json"
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/unattributed-scale.json" final
node - "$TEMP_DIR/unattributed-scale.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.finalGatePassed || !evidence.scaleTransitions.general.scaleOutObserved) process.exit(1);
NODE

write_fixtures 1 false
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/isolated.json" baseline
cp "$TEMP_DIR/isolated.json" "$INPUT_DIR/existing-evidence.json"
node - "$INPUT_DIR" <<'NODE'
const fs = require("fs");
const directory = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(`${directory}/${name}`, "utf8"));
const write = (name, value) => fs.writeFileSync(`${directory}/${name}`, `${JSON.stringify(value)}\n`);
const nodes = read("nodes.json");
nodes.items.push(
  { metadata: { name: "node-private-c", labels: { "karpenter.sh/nodepool": "asklake-general" } }, status: { allocatable: { cpu: "2", memory: "8Gi" } } },
  { metadata: { name: "node-private-d", labels: { "karpenter.sh/nodepool": "asklake-spark" } }, spec: { taints: [{ key: "asklake.io/workload-class", value: "spark", effect: "NoSchedule" }] }, status: { allocatable: { cpu: "4", memory: "16Gi" } } },
);
write("nodes.json", nodes);
const run = "686ba49feabc4a99";
const positive = (pool, node) => ({
  metadata: { name: `asklake-day17-${pool}-scale-private`, uid: `${pool}-positive-uid`, labels: { "asklake.io/day17-run": run, "app.kubernetes.io/name": `asklake-day17-${pool}-scale` } },
  spec: { nodeName: node, containers: [{ resources: { requests: { cpu: "1", memory: "512Mi" } } }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
});
const negative = { metadata: { name: "asklake-day17-spark-negative", uid: "negative-uid", labels: { "asklake.io/day17-run": run } }, spec: { nodeSelector: { "asklake.io/workload-class": "spark" }, containers: [] }, status: { phase: "Pending" } };
const pods = read("pods.json");
pods.items.push(positive("general", "node-private-c"), positive("spark", "node-private-d"), negative);
write("pods.json", pods);
const allPods = read("allpods.json");
allPods.items.push(...pods.items.slice(-3));
write("allpods.json", allPods);
const deployments = read("deployments.json");
for (const pool of ["general", "spark"]) deployments.items.push({ metadata: { name: `asklake-day17-${pool}-scale`, uid: `${pool}-deployment-uid`, generation: 1, labels: { "asklake.io/day17-run": run } }, spec: { selector: { matchLabels: { "app.kubernetes.io/name": `asklake-day17-${pool}-scale` } }, template: { spec: {} } }, status: {} });
write("deployments.json", deployments);
write("events.json", { items: [{ involvedObject: { uid: "negative-uid" }, reason: "FailedScheduling", message: "0/2 nodes are available: insufficient cpu", count: 1 }] });
const releases = read("helm-releases.json");
releases.push({ name: "asklake-day17-nodepool-smoke", namespace: "asklake-dev", revision: "1", chart: "asklake-day17-nodepool-smoke-0.1.0", status: "deployed" });
write("helm-releases.json", releases);
write("smoke-release-values.json", { runFingerprint: run });
write("transition-proof.json", { runFingerprint: run, general: { pendingObserved: true, newNodeObserved: true, scheduledOnNewNode: true, runningObserved: true }, spark: { pendingObserved: true, newNodeObserved: true, scheduledOnNewNode: true, runningObserved: true } });
NODE
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/generic-taint.json" sample
node - "$TEMP_DIR/generic-taint.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (evidence.snapshots.at(-1).untoleratedSparkTaintObserved) process.exit(1);
NODE
cp "$TEMP_DIR/isolated.json" "$INPUT_DIR/existing-evidence.json"
node - "$INPUT_DIR/events.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.items[0].message = "0/2 nodes are available: node(s) had untolerated taint(s)";
fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
NODE
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/isolated.json" sample
cp "$INPUT_DIR/transition-proof.json" "$TEMP_DIR/transition-proof.json"
write_fixtures 1 false
cp "$TEMP_DIR/isolated.json" "$INPUT_DIR/existing-evidence.json"
cp "$TEMP_DIR/transition-proof.json" "$INPUT_DIR/transition-proof.json"
ASKLAKE_DAY17_SCOPE=isolated ASKLAKE_DAY17_RUN_TOKEN=test-run-token node "$ROOT_DIR/scripts/build-eks-day17-autoscaling-snapshot.mjs" "$INPUT_DIR" "$TEMP_DIR/isolated.json" final
node - "$TEMP_DIR/isolated.json" <<'NODE'
const evidence = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (!evidence.finalGatePassed || !evidence.scaleTransitions.general.scaleOutObserved || !evidence.scaleTransitions.spark.scaleInObserved || !evidence.snapshots[1].untoleratedSparkTaintObserved) process.exit(1);
NODE

echo "EKS Day 17 autoscaling evidence tests passed."
