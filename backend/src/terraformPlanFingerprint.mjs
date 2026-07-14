import { createHash } from "node:crypto";

export const TERRAFORM_PLAN_FINGERPRINT_SCHEMA = "asklake.terraform-plan-fingerprint.v1";

export function fingerprintTerraformPlan(planValue) {
  const plan = requiredObject(planValue);
  if (typeof plan.format_version !== "string"
    || (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes))) {
    fail();
  }
  const normalized = structuredClone(plan);
  delete normalized.timestamp;
  const canonical = canonicalJson(normalized);
  return Object.freeze({
    schemaVersion: TERRAFORM_PLAN_FINGERPRINT_SCHEMA,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

function requiredObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
}

function fail() {
  const error = new Error("Terraform plan JSON is invalid.");
  error.code = "TERRAFORM_PLAN_FINGERPRINT_INVALID";
  throw error;
}
