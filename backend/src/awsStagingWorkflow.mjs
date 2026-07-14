const AWS_REGION = "ap-northeast-2";
const STACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,15}$/;
const BUCKET_PATTERN = /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const OPERATIONS = new Set(["plan", "apply", "artifacts", "destroy"]);

export function prepareAwsStagingTerraformInputs(input, contract, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const operation = String(input.operation || "").trim().toLowerCase();
  const stackId = String(input.stackId || "").trim();
  if (!OPERATIONS.has(operation)) fail("AWS staging operation is invalid.");
  if (!STACK_ID_PATTERN.test(stackId)) fail("AWS staging stack identity is invalid.");
  validateConfirmation(operation, stackId, input.confirmation);

  const region = String(input.region || AWS_REGION).trim();
  if (region !== contract.region || region !== AWS_REGION) fail("AWS staging region is invalid.");
  const accountId = requiredPattern(input.awsAccountId, /^[0-9]{12}$/, "AWS account identity");
  const roleArn = requiredPattern(
    input.githubOidcRoleArn,
    /^arn:aws:iam::([0-9]{12}):role\/[\w+=,.@\/-]+$/,
    "GitHub OIDC role",
  );
  if (roleArn.match(/^arn:aws:iam::([0-9]{12}):/)?.[1] !== accountId) {
    fail("GitHub OIDC role does not match the AWS account.");
  }
  const stateBucketName = requiredPattern(input.stateBucketName, BUCKET_PATTERN, "Terraform state bucket");
  if (stateBucketName.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(stateBucketName)) {
    fail("Terraform state bucket is invalid.");
  }
  const stateKmsKeyArn = requiredPattern(
    input.stateKmsKeyArn,
    /^arn:aws:kms:([a-z0-9-]+):([0-9]{12}):key\/[0-9a-f-]{36}$/,
    "Terraform state KMS key",
  );
  const kmsMatch = /^arn:aws:kms:([a-z0-9-]+):([0-9]{12}):/.exec(stateKmsKeyArn);
  if (kmsMatch?.[1] !== region || kmsMatch?.[2] !== accountId) {
    fail("Terraform state KMS key does not match the AWS account and region.");
  }
  const availableVcpu = finiteNumber(input.availableEmrServerlessConcurrentVcpu, "EMR Serverless quota");
  if (availableVcpu < contract.runtime.minimumRequiredAccountConcurrentVcpu) {
    fail("EMR Serverless concurrent vCPU quota is below the Phase contract.");
  }
  const budgetEmail = requiredPattern(
    input.budgetNotificationEmail,
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    "Budget notification endpoint",
  );
  const enableSmokeRunner = booleanValue(input.enableSmokeRunner);
  const smokeRunnerAmiId = String(input.smokeRunnerAmiId || "").trim();
  if (enableSmokeRunner && !/^ami-[0-9a-f]{17}$/.test(smokeRunnerAmiId)) {
    fail("Enabled smoke runner requires an approved AMI identity.");
  }
  if (!enableSmokeRunner && smokeRunnerAmiId && !/^ami-[0-9a-f]{17}$/.test(smokeRunnerAmiId)) {
    fail("Smoke runner AMI identity is invalid.");
  }

  const expiresAt = resolveExpiry(input, contract, now);
  const backend = [
    `bucket       = "${stateBucketName}"`,
    `key          = "asklake/staging/${stackId}/terraform.tfstate"`,
    `region       = "${region}"`,
    "use_lockfile = true",
    "encrypt      = true",
    `kms_key_id   = "${stateKmsKeyArn}"`,
    "",
  ].join("\n");
  const variables = Object.freeze({
    available_emr_serverless_concurrent_vcpu: availableVcpu,
    aws_account_id: accountId,
    budget_notification_email: budgetEmail,
    enable_smoke_runner: enableSmokeRunner,
    expires_at: expiresAt,
    github_oidc_role_arn: roleArn,
    smoke_runner_ami_id: enableSmokeRunner ? smokeRunnerAmiId : null,
    stack_id: stackId,
  });

  return Object.freeze({
    backend,
    expiresAt,
    operation,
    stackId,
    variables,
    variablesJson: `${JSON.stringify(variables, null, 2)}\n`,
  });
}

export function extractEmrServerlessConcurrentVcpu(payload, contract) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.Quotas)) {
    fail("AWS Service Quotas response is invalid.");
  }
  const candidates = payload.Quotas.filter((quota) => {
    const name = String(quota?.QuotaName || "").toLowerCase();
    const usage = quota?.UsageMetric?.MetricDimensions || {};
    return (name.includes("concurrent") && name.includes("vcpu"))
      || (String(usage.Service || "").toLowerCase().includes("emr") && String(usage.Resource || "").toLowerCase() === "vcpu");
  });
  if (candidates.length !== 1) fail("EMR Serverless concurrent vCPU quota could not be identified uniquely.");
  const value = finiteNumber(candidates[0].Value, "EMR Serverless quota");
  if (value < contract.runtime.minimumRequiredAccountConcurrentVcpu) {
    fail("EMR Serverless concurrent vCPU quota is below the Phase contract.");
  }
  return value;
}

function resolveExpiry(input, contract, now) {
  if (!Number.isFinite(now.getTime())) fail("Current time is invalid.");
  const explicit = String(input.expiresAt || "").trim();
  let expiresAt;
  if (explicit) {
    expiresAt = new Date(explicit);
  } else {
    const ttlHours = finiteNumber(input.ttlHours || contract.costControl.stackTtlHours, "Stack TTL");
    if (ttlHours <= 0 || ttlHours > contract.costControl.maximumStackTtlHours) {
      fail("Stack TTL is outside the Phase contract.");
    }
    expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  }
  const ttlMilliseconds = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(expiresAt.getTime()) || ttlMilliseconds <= 0) fail("Stack expiry must be in the future.");
  if (ttlMilliseconds > contract.costControl.maximumStackTtlHours * 60 * 60 * 1000) {
    fail("Stack expiry exceeds the Phase contract maximum TTL.");
  }
  return expiresAt.toISOString().replace(".000Z", "Z");
}

function validateConfirmation(operation, stackId, confirmation) {
  const value = String(confirmation || "").trim();
  if (operation === "plan") {
    if (value) fail("Plan operation must not carry a mutation confirmation.");
    return;
  }
  if (value !== `${operation}:${stackId}`) fail("AWS staging mutation confirmation does not match the requested operation and stack.");
}

function requiredPattern(value, pattern, name) {
  const text = String(value || "").trim();
  if (!pattern.test(text) || /[\r\n\0]/.test(text)) fail(`${name} is invalid.`);
  return text;
}

function finiteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${name} is invalid.`);
  return parsed;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["", "0", "false", "no", "off"].includes(normalized)) return false;
  fail("Smoke runner flag is invalid.");
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_WORKFLOW_INPUT_INVALID";
  throw error;
}
