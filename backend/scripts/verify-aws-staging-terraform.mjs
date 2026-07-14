import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const terraformRoot = path.join(repositoryRoot, "infra", "terraform");
const contract = JSON.parse(
  readFileSync(path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"), "utf8"),
);

function collectFiles(directory, prefix = "") {
  const files = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".terraform") {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [childPath, content] of collectFiles(absolute, relative)) {
        files.set(childPath, content);
      }
      continue;
    }
    files.set(relative, readFileSync(absolute, "utf8"));
  }
  return files;
}

function requiredFile(files, relativePath) {
  assert.ok(files.has(relativePath), `missing Terraform file: ${relativePath}`);
  return files.get(relativePath);
}

function assertContains(source, fragment, message) {
  assert.ok(source.includes(fragment), message);
}

function validateTerraform(files) {
  const bootstrapVersions = requiredFile(files, "bootstrap/versions.tf");
  const bootstrapMain = requiredFile(files, "bootstrap/main.tf");
  const bootstrapReadme = requiredFile(files, "bootstrap/README.md");
  const stagingVersions = requiredFile(files, "environments/staging/versions.tf");
  const stagingVariables = requiredFile(files, "environments/staging/variables.tf");
  const stagingLocals = requiredFile(files, "environments/staging/locals.tf");
  const stagingContract = requiredFile(files, "environments/staging/contract.tf");
  const stagingMain = requiredFile(files, "environments/staging/main.tf");
  const stagingOutputs = requiredFile(files, "environments/staging/outputs.tf");
  const backendExample = requiredFile(files, "environments/staging/backend.hcl.example");
  const networkMain = requiredFile(files, "modules/network/main.tf");
  const storageMain = requiredFile(files, "modules/storage/main.tf");
  const mskMain = requiredFile(files, "modules/msk/main.tf");
  const emrMain = requiredFile(files, "modules/emr/main.tf");
  const iamMain = requiredFile(files, "modules/iam/main.tf");
  const observabilityMain = requiredFile(files, "modules/observability/main.tf");
  const costMain = requiredFile(files, "modules/cost-control/main.tf");
  const runnerMain = requiredFile(files, "modules/smoke-runner/main.tf");
  const verificationScript = requiredFile(files, "scripts/verify.sh");
  requiredFile(files, "bootstrap/bootstrap.tftest.hcl");
  requiredFile(files, "environments/staging/staging.tftest.hcl");

  assertContains(bootstrapVersions, 'version = "= 6.54.0"', "bootstrap AWS provider version drifted");
  assertContains(stagingVersions, 'version = "= 6.54.0"', "staging AWS provider version drifted");
  assertContains(bootstrapVersions, 'backend "s3" {}', "bootstrap S3 backend declaration is required");
  assertContains(stagingVersions, 'backend "s3" {}', "staging S3 backend declaration is required");

  assertContains(bootstrapMain, 'status = "Enabled"', "state bucket versioning is required");
  assertContains(bootstrapMain, "prevent_destroy = true", "state bootstrap must be destroy-protected");
  assertContains(bootstrapMain, 'sse_algorithm     = "aws:kms"', "state bucket KMS encryption is required");
  assertContains(bootstrapReadme, "use_lockfile=true", "state bootstrap migration must enable S3 locking");
  assertContains(backendExample, "use_lockfile = true", "staging backend must enable S3 locking");
  assertContains(backendExample, "kms_key_id", "staging backend must require a KMS key");

  assertContains(
    stagingVariables,
    contract.naming.stackIdPattern.replaceAll("\\", "\\\\"),
    "Terraform stack ID validation drifted from the Phase 0 contract",
  );
  assertContains(stagingLocals, `bucket_region_alias = "${contract.naming.bucketRegionAlias}"`, "bucket region alias drifted");
  assertContains(
    stagingLocals,
    'bucket_prefix       = "asklake-stg-${var.aws_account_id}-${local.bucket_region_alias}-${var.stack_id}"',
    "bucket naming template drifted",
  );
  assertContains(stagingLocals, `vpc_cidr = "${contract.network.vpcCidr}"`, "VPC CIDR drifted");
  for (const cidr of contract.network.privateSubnetCidrs) {
    assertContains(stagingLocals, `"${cidr}"`, `private subnet CIDR missing: ${cidr}`);
  }
  assertContains(stagingLocals, 'Environment = local.environment', "required Environment tag is missing");
  assertContains(stagingLocals, 'StackId     = var.stack_id', "required StackId tag is missing");
  assertContains(stagingLocals, 'ExpiresAt   = var.expires_at', "required ExpiresAt tag is missing");
  assertContains(stagingContract, 'resource "terraform_data" "contract_guard"', "root contract guard is missing");
  assertContains(stagingContract, "available_emr_serverless_concurrent_vcpu >= 16", "EMR quota guard is missing");
  assertContains(stagingContract, "longest staging bucket name", "S3 name-length guard is missing");
  assertContains(stagingContract, "github_oidc_role_arn must belong", "OIDC account boundary is missing");

  const expectedModules = [
    "network",
    "storage",
    "observability",
    "msk",
    "emr",
    "iam",
    "smoke_runner",
    "cost_control",
  ];
  for (const moduleName of expectedModules) {
    assert.match(stagingMain, new RegExp(`module\\s+"${moduleName}"`), `missing root module: ${moduleName}`);
  }

  assert.match(stagingMain, /maximum_vcpu\s*=\s*16\b/, "EMR maximum vCPU contract drifted");
  assert.match(stagingMain, /maximum_memory_gb\s*=\s*64\b/, "EMR maximum memory contract drifted");
  assert.match(stagingMain, /maximum_disk_gb\s*=\s*320\b/, "EMR maximum disk contract drifted");
  assert.match(stagingMain, /maximum_executors\s*=\s*7\b/, "EMR maximum executors contract drifted");
  assert.match(stagingMain, /budget_limit_usd\s*=\s*30\b/, "AWS Budget contract drifted");
  assert.match(stagingMain, /alert_thresholds_percent\s*=\s*\[50, 80, 100\]/, "AWS Budget thresholds drifted");

  for (const service of contract.network.requiredInterfaceEndpoints) {
    assertContains(networkMain, `"${service}"`, `required interface endpoint missing: ${service}`);
  }
  assert.match(networkMain, /service_name\s*=\s*"com\.amazonaws\.\$\{var\.region\}\.s3"/, "S3 gateway endpoint is missing");
  assert.match(networkMain, /map_public_ip_on_launch\s*=\s*false/, "private subnets must disable public IP assignment");
  assert.match(networkMain, /from_port\s*=\s*9098\b/, "MSK IAM ingress port is missing");
  assert.match(
    networkMain,
    /referenced_security_group_id\s*=\s*aws_security_group\.emr\.id/,
    "MSK ingress must be SG-scoped",
  );

  for (const kind of ["artifact", "output", "checkpoint", "report"]) {
    assertContains(storageMain, `${kind}`, `missing ${kind} S3 bucket`);
  }
  assert.match(storageMain, /force_destroy\s*=\s*true/, "ephemeral staging buckets must support cleanup");
  assert.match(storageMain, /block_public_policy\s*=\s*true/, "S3 public access block is required");
  assert.match(storageMain, /sse_algorithm\s*=\s*"aws:kms"/, "staging S3 KMS encryption is required");
  assert.match(storageMain, /days\s*=\s*1\b/, "ephemeral S3 lifecycle must remain bounded");

  assertContains(mskMain, 'resource "aws_msk_serverless_cluster"', "MSK Serverless resource is missing");
  assert.match(mskMain, /enabled\s*=\s*true/, "MSK IAM authentication must be enabled");
  assert.match(mskMain, /subnet_ids\s*=\s*var\.private_subnet_ids/, "MSK must use private subnets");

  assert.match(emrMain, /architecture\s*=\s*"X86_64"/, "EMR architecture decision drifted");
  assert.match(emrMain, /max_concurrent_runs\s*=\s*1\b/, "EMR application concurrency must remain one");
  assert.match(emrMain, /idle_timeout_minutes\s*=\s*var\.auto_stop_idle_minutes/, "EMR auto-stop is missing");
  assertContains(emrMain, "job_level_cost_allocation_configuration", "EMR job-level cost allocation is missing");
  assert.match(emrMain, /classification\s*=\s*"spark-defaults"/, "EMR Spark defaults are missing");
  assertContains(emrMain, '"spark.dynamicAllocation.maxExecutors"', "EMR executor cap is missing");
  assertContains(emrMain, "cloudwatch_logging_configuration", "EMR CloudWatch logging is missing");
  assertContains(emrMain, "s3_monitoring_configuration", "EMR S3 monitoring is missing");

  assertContains(iamMain, 'identifiers = ["emr-serverless.amazonaws.com"]', "EMR trust principal drifted");
  assertContains(iamMain, 'variable = "aws:SourceAccount"', "EMR trust must bind SourceAccount");
  assertContains(iamMain, '"iam:PassRole"', "smoke runner must have bounded PassRole permission");
  assertContains(iamMain, 'variable = "iam:PassedToService"', "PassRole must bind EMR Serverless");
  assertContains(iamMain, '"kafka-cluster:ReadData"', "MSK read permission is missing");
  assertContains(iamMain, '"kafka-cluster:WriteData"', "smoke producer permission is missing");
  assertContains(iamMain, '"logs:DescribeLogGroups"', "EMR CloudWatch discovery permission is missing");
  assertContains(iamMain, "AmazonSSMManagedInstanceCore", "SSM runner policy is missing");

  assertContains(observabilityMain, 'resource "aws_cloudwatch_log_group"', "CloudWatch log groups are missing");
  assertContains(observabilityMain, "retention_in_days = var.log_retention_days", "CloudWatch retention is not bounded");
  assertContains(costMain, 'resource "aws_budgets_budget"', "AWS Budget resource is missing");
  assert.match(costMain, /name\s*=\s*"TagKeyValue"/, "AWS Budget must be stack-tag scoped");
  assert.match(runnerMain, /associate_public_ip_address\s*=\s*false/, "smoke runner must not receive a public IP");
  assert.match(runnerMain, /http_tokens\s*=\s*"required"/, "smoke runner must require IMDSv2");
  assert.doesNotMatch(runnerMain, /key_name\s*=/, "smoke runner must not configure an SSH key");

  assert.match(
    stagingOutputs,
    /output\s+"msk_bootstrap_brokers_sasl_iam"[\s\S]*?sensitive\s*=\s*true/,
    "MSK broker output must remain redacted",
  );
  assert.match(stagingOutputs, /public_ingress_enabled\s*=\s*false/, "public ingress contract output drifted");
  assert.match(stagingOutputs, /nat_gateway_enabled\s*=\s*false/, "no-NAT contract output drifted");
  assert.match(stagingOutputs, /applications_concurrent\s*=\s*false/, "sequential application contract drifted");
  assert.match(stagingOutputs, /stack_id\s*=\s*var\.stack_id/, "Phase 2 stack identity output is missing");

  const terraformSource = [...files.entries()]
    .filter(([relativePath]) => relativePath.endsWith(".tf"))
    .map(([, content]) => content)
    .join("\n");
  for (const resourceType of [
    "aws_vpc",
    "aws_subnet",
    "aws_vpc_endpoint",
    "aws_s3_bucket",
    "aws_kms_key",
    "aws_msk_serverless_cluster",
    "aws_emrserverless_application",
    "aws_iam_role",
    "aws_cloudwatch_log_group",
    "aws_budgets_budget",
    "aws_instance",
  ]) {
    assert.match(terraformSource, new RegExp(`resource\\s+"${resourceType}"`), `missing resource type: ${resourceType}`);
  }

  for (const forbiddenResource of [
    "aws_nat_gateway",
    "aws_internet_gateway",
    "aws_eip",
    "aws_iam_access_key",
    "aws_key_pair",
  ]) {
    assert.doesNotMatch(
      terraformSource,
      new RegExp(`resource\\s+"${forbiddenResource}"`),
      `forbidden staging resource found: ${forbiddenResource}`,
    );
  }
  assert.doesNotMatch(terraformSource, /0\.0\.0\.0\/0/, "public IPv4 CIDR is forbidden");
  assert.doesNotMatch(terraformSource, /associate_public_ip_address\s*=\s*true/, "public runner IP is forbidden");
  assert.doesNotMatch(terraformSource, /map_public_ip_on_launch\s*=\s*true/, "public subnet behavior is forbidden");
  assert.doesNotMatch(terraformSource, /AKIA[0-9A-Z]{16}/, "AWS access key shaped value is forbidden");
  assert.doesNotMatch(terraformSource, /aws_secret_access_key\s*=/i, "static AWS secret configuration is forbidden");

  assertContains(verificationScript, "fmt -check -recursive", "Terraform fmt verification is missing");
  assertContains(verificationScript, "init -backend=false", "credential-free backend initialization is missing");
  assertContains(verificationScript, " validate", "Terraform validate verification is missing");
  assertContains(verificationScript, " test -no-color", "Terraform mock plan verification is missing");
}

function expectInvalid(files, relativePath, mutate, expectedMessage) {
  const candidate = new Map(files);
  candidate.set(relativePath, mutate(requiredFile(candidate, relativePath)));
  assert.throws(() => validateTerraform(candidate), expectedMessage);
}

const files = collectFiles(terraformRoot);
validateTerraform(files);

expectInvalid(
  files,
  "modules/network/main.tf",
  (source) => `${source}\nresource "aws_nat_gateway" "unsafe" {}`,
  /forbidden staging resource found: aws_nat_gateway/,
);
expectInvalid(
  files,
  "modules/network/main.tf",
  (source) => source.replace('    "emr-serverless",\n', ""),
  /required interface endpoint missing: emr-serverless/,
);
expectInvalid(
  files,
  "environments/staging/main.tf",
  (source) => source.replace(/maximum_vcpu\s*=\s*16\b/, "maximum_vcpu = 32"),
  /EMR maximum vCPU contract drifted/,
);
expectInvalid(
  files,
  "environments/staging/outputs.tf",
  (source) => source.replace("sensitive   = true", "sensitive   = false"),
  /MSK broker output must remain redacted/,
);
expectInvalid(
  files,
  "bootstrap/main.tf",
  (source) => source.replace('status = "Enabled"', 'status = "Suspended"'),
  /state bucket versioning is required/,
);

console.log("AWS staging Terraform Phase 1 static contract verified.");
