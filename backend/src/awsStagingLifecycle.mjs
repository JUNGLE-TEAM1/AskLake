export const AWS_STAGING_TTL_SWEEP_SCHEMA = "asklake.aws-staging-ttl-sweep.v1";

const SAFE_STACK_ID = /^[a-z0-9][a-z0-9-]{2,15}$/;
const STATE_KEY = /^asklake\/staging\/([a-z0-9][a-z0-9-]{2,15})\/terraform\.tfstate$/;

export function inspectAwsStagingTerraformState({ stateKey, terraformState }, contract, now = new Date()) {
  const key = requiredText(stateKey, "stateKey");
  const match = STATE_KEY.exec(key);
  if (!match) return invalid(key, "state-key-invalid");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw lifecycleError("Current time is invalid.");
  if (!terraformState || typeof terraformState !== "object" || Array.isArray(terraformState)) {
    return invalid(key, "terraform-state-invalid");
  }
  const resources = Array.isArray(terraformState.resources) ? terraformState.resources : null;
  if (!resources) return invalid(key, "terraform-state-invalid");
  if (resources.length === 0) return { resourceTagCount: 0, stateKey: key, status: "empty" };

  const tags = resources.flatMap((resource) => (
    Array.isArray(resource?.instances)
      ? resource.instances.map((instance) => instance?.attributes?.tags).filter(isObject)
      : []
  )).filter((value) => isStagingTags(value, contract));
  if (tags.length === 0) return invalid(key, "staging-tags-missing");

  const stackIds = new Set(tags.map((value) => String(value.StackId || "")));
  const expiries = new Set(tags.map((value) => String(value.ExpiresAt || "")));
  if (stackIds.size !== 1 || expiries.size !== 1) return invalid(key, "staging-tags-inconsistent");
  const stackId = [...stackIds][0];
  const expiresAt = [...expiries][0];
  if (!SAFE_STACK_ID.test(stackId) || stackId !== match[1]) return invalid(key, "stack-identity-mismatch");
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return invalid(key, "expiry-invalid");
  const graceMinutes = Number(contract?.lifecycle?.ttlSweep?.expiredStackGraceMinutes);
  if (!Number.isSafeInteger(graceMinutes) || graceMinutes < 0) throw lifecycleError("TTL sweep grace contract is invalid.");
  return {
    expiresAt: new Date(expiresAtMs).toISOString().replace(".000Z", "Z"),
    resourceTagCount: tags.length,
    stackId,
    stateKey: key,
    status: now.getTime() >= expiresAtMs + graceMinutes * 60_000 ? "expired" : "active",
  };
}

export function createAwsStagingTtlSweepEvidence({ states }, contract, now = new Date()) {
  if (!Array.isArray(states)) throw lifecycleError("TTL sweep states are invalid.");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw lifecycleError("Current time is invalid.");
  const maximum = Number(contract?.lifecycle?.ttlSweep?.maximumStateFilesPerRun);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || states.length > maximum) {
    throw lifecycleError("TTL sweep state count exceeds the Phase contract.");
  }
  const normalized = states.map(normalizeState).sort((left, right) => left.stateKey.localeCompare(right.stateKey));
  const summary = {
    activeCount: normalized.filter((state) => state.status === "active").length,
    emptyCount: normalized.filter((state) => state.status === "empty").length,
    expiredCount: normalized.filter((state) => state.status === "expired").length,
    invalidCount: normalized.filter((state) => state.status === "invalid").length,
    stateCount: normalized.length,
  };
  return Object.freeze({
    automaticDestroyAllowed: contract.lifecycle.ttlSweep.automaticDestroyAllowed,
    contractId: contract.contractId,
    environment: contract.environment,
    generatedAt: now.toISOString().replace(".000Z", "Z"),
    region: contract.region,
    schemaVersion: AWS_STAGING_TTL_SWEEP_SCHEMA,
    states: Object.freeze(normalized),
    summary: Object.freeze(summary),
  });
}

export function evaluateAwsStagingTtlSweepEvidence(evidence, contract) {
  if (!isObject(evidence)) throw lifecycleError("TTL sweep evidence is invalid.");
  if (evidence.schemaVersion !== AWS_STAGING_TTL_SWEEP_SCHEMA
    || evidence.contractId !== contract.contractId
    || evidence.environment !== contract.environment
    || evidence.region !== contract.region
    || evidence.automaticDestroyAllowed !== false) {
    throw lifecycleError("TTL sweep evidence does not match the Phase contract.");
  }
  if (!Number.isFinite(Date.parse(String(evidence.generatedAt || "")))) throw lifecycleError("TTL sweep timestamp is invalid.");
  if (!Array.isArray(evidence.states)) throw lifecycleError("TTL sweep states are invalid.");
  const expected = createAwsStagingTtlSweepEvidence({ states: evidence.states }, contract, new Date(evidence.generatedAt));
  const summary = expected.summary;
  const actual = evidence.summary || {};
  for (const name of Object.keys(summary)) {
    if (actual[name] !== summary[name]) throw lifecycleError("TTL sweep summary is invalid.");
  }
  return Object.freeze({
    attentionRequired: summary.expiredCount > 0 || summary.invalidCount > 0,
    summary,
  });
}

function normalizeState(value) {
  if (!isObject(value)) throw lifecycleError("TTL sweep state is invalid.");
  const stateKey = requiredText(value.stateKey, "stateKey");
  const status = String(value.status || "");
  if (!["active", "empty", "expired", "invalid"].includes(status)) throw lifecycleError("TTL sweep state status is invalid.");
  if (status === "invalid") return { reason: requiredText(value.reason, "invalid reason"), stateKey, status };
  if (status === "empty") return { resourceTagCount: nonNegativeInteger(value.resourceTagCount, "resourceTagCount"), stateKey, status };
  const stackId = requiredText(value.stackId, "stackId");
  if (!SAFE_STACK_ID.test(stackId)) throw lifecycleError("TTL sweep stack ID is invalid.");
  const expiresAt = new Date(requiredText(value.expiresAt, "expiresAt"));
  if (!Number.isFinite(expiresAt.getTime())) throw lifecycleError("TTL sweep expiry is invalid.");
  return {
    expiresAt: expiresAt.toISOString().replace(".000Z", "Z"),
    resourceTagCount: nonNegativeInteger(value.resourceTagCount, "resourceTagCount"),
    stackId,
    stateKey,
    status,
  };
}

function isStagingTags(tags, contract) {
  const required = contract?.naming?.requiredTags || {};
  return tags.Project === required.Project
    && tags.Environment === required.Environment
    && tags.ManagedBy === required.ManagedBy
    && tags.Issue === required.Issue
    && typeof tags.StackId === "string"
    && typeof tags.ExpiresAt === "string";
}

function invalid(stateKey, reason) {
  return { reason, stateKey, status: "invalid" };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\0]/.test(text)) throw lifecycleError(`${name} is invalid.`);
  return text;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw lifecycleError(`${name} is invalid.`);
  return parsed;
}

function lifecycleError(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_TTL_SWEEP_INVALID";
  return error;
}
