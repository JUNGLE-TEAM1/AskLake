import { loadKafkaJs } from "./kafka-codecs.mjs";

export const KAFKA_RUNTIME_IDS = Object.freeze({
  MSK: "msk",
  REDPANDA: "redpanda",
});

const DEFAULT_LOCAL_BROKER = "127.0.0.1:19092";
const DEFAULT_MSK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOPIC_PATTERN = /^[a-zA-Z0-9._-]{1,249}$/;
const TOPIC_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,248}$/;

export class KafkaRuntimeError extends Error {
  constructor(code, message, { details, runtime, stage, status = 500 } = {}) {
    super(message);
    this.name = "KafkaRuntimeError";
    this.code = code;
    this.status = status;
    if (details && typeof details === "object") this.details = details;
    if (runtime) this.runtime = runtime;
    if (stage) this.stage = stage;
  }
}

export function resolveKafkaRuntimeConfig({ broker, brokers, env = process.env } = {}) {
  const runtime = canonicalKafkaRuntime(env.ASKLAKE_KAFKA_RUNTIME || KAFKA_RUNTIME_IDS.REDPANDA);
  const environment = canonicalEnvironment(
    env.ASKLAKE_KAFKA_ENVIRONMENT
      || env.ASKLAKE_STORAGE_ENVIRONMENT
      || (runtime === KAFKA_RUNTIME_IDS.MSK ? "staging" : "local"),
  );
  const configuredBrokers = runtime === KAFKA_RUNTIME_IDS.MSK
    ? firstPresent(env.ASKLAKE_MSK_BOOTSTRAP_BROKERS, brokers, broker)
    : firstPresent(brokers, broker, env.ASKLAKE_KAFKA_BROKER, DEFAULT_LOCAL_BROKER);
  const brokerList = parseBrokerList(configuredBrokers);
  const connectionTimeoutMs = positiveInteger(
    env.ASKLAKE_KAFKA_CONNECT_TIMEOUT_MS,
    "ASKLAKE_KAFKA_CONNECT_TIMEOUT_MS",
    3000,
  );
  const requestTimeoutMs = positiveInteger(
    env.ASKLAKE_KAFKA_REQUEST_TIMEOUT_MS,
    "ASKLAKE_KAFKA_REQUEST_TIMEOUT_MS",
    5000,
  );
  const retryCount = nonnegativeInteger(
    env.ASKLAKE_KAFKA_RETRY_COUNT,
    "ASKLAKE_KAFKA_RETRY_COUNT",
    runtime === KAFKA_RUNTIME_IDS.MSK ? 4 : 2,
  );

  if (runtime === KAFKA_RUNTIME_IDS.MSK) {
    if (!parseBoolean(env.ASKLAKE_MSK_ENABLED, false)) {
      throw configurationError("ASKLAKE_KAFKA_RUNTIME=msk requires ASKLAKE_MSK_ENABLED=true.", runtime);
    }
    if (!env.ASKLAKE_MSK_BOOTSTRAP_BROKERS && !brokers && !broker) {
      throw configurationError("Amazon MSK requires ASKLAKE_MSK_BOOTSTRAP_BROKERS.", runtime);
    }
    const region = String(env.ASKLAKE_MSK_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || "").trim();
    if (!region) {
      throw configurationError("Amazon MSK requires ASKLAKE_MSK_REGION or AWS_REGION.", runtime);
    }
    const authMode = String(env.ASKLAKE_MSK_AUTH_MODE || "iam").trim().toLowerCase();
    if (authMode !== "iam") {
      throw configurationError("MSK Serverless supports only IAM authentication in AskLake.", runtime);
    }
    if (!parseBoolean(env.ASKLAKE_MSK_TLS_ENABLED, true)) {
      throw configurationError("MSK IAM authentication requires TLS.", runtime);
    }
    const topicPrefix = validateTopicPrefix(
      String(env.ASKLAKE_KAFKA_TOPIC_PREFIX || `asklake.${environment}`).trim(),
      runtime,
    );
    return Object.freeze({
      authMode,
      brokers: brokerList,
      connectionTimeoutMs,
      environment,
      region,
      requestTimeoutMs,
      retryCount,
      runtime,
      tls: true,
      topicPolicy: Object.freeze({
        enforced: parseBoolean(env.ASKLAKE_KAFKA_TOPIC_POLICY_ENFORCED, true),
        minPartitions: positiveInteger(
          env.ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS,
          "ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS",
          3,
        ),
        retentionMs: positiveInteger(
          env.ASKLAKE_KAFKA_TOPIC_RETENTION_MS,
          "ASKLAKE_KAFKA_TOPIC_RETENTION_MS",
          DEFAULT_MSK_RETENTION_MS,
        ),
      }),
      topicPrefix,
    });
  }

  return Object.freeze({
    authMode: "none",
    brokers: brokerList,
    connectionTimeoutMs,
    environment,
    region: "",
    requestTimeoutMs,
    retryCount,
    runtime,
    tls: false,
    topicPolicy: Object.freeze({
      enforced: parseBoolean(env.ASKLAKE_KAFKA_TOPIC_POLICY_ENFORCED, false),
      minPartitions: positiveInteger(
        env.ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS,
        "ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS",
        1,
      ),
      retentionMs: positiveInteger(
        env.ASKLAKE_KAFKA_TOPIC_RETENTION_MS,
        "ASKLAKE_KAFKA_TOPIC_RETENTION_MS",
        DEFAULT_MSK_RETENTION_MS,
      ),
    }),
    topicPrefix: validateOptionalTopicPrefix(env.ASKLAKE_KAFKA_TOPIC_PREFIX, runtime),
  });
}

export async function createKafkaClient({
  broker,
  brokers,
  clientId,
  config = resolveKafkaRuntimeConfig({ broker, brokers }),
  connectionTimeoutMs = config.connectionTimeoutMs,
  requestTimeoutMs = config.requestTimeoutMs,
  retries = config.retryCount,
  tokenGenerator,
} = {}) {
  const kafkaJs = await loadKafkaJs();
  const options = await kafkaClientOptions({
    clientId,
    config,
    connectionTimeoutMs,
    requestTimeoutMs,
    retries,
    tokenGenerator,
  });
  return {
    client: new kafkaJs.Kafka(options),
    config,
    kafkaJs,
    options,
  };
}

export async function kafkaClientOptions({
  clientId,
  config,
  connectionTimeoutMs = config?.connectionTimeoutMs,
  requestTimeoutMs = config?.requestTimeoutMs,
  retries = config?.retryCount,
  tokenGenerator,
} = {}) {
  if (!config) throw configurationError("Kafka Runtime config is required.");
  const options = {
    brokers: [...config.brokers],
    clientId: validateClientId(clientId),
    connectionTimeout: connectionTimeoutMs,
    requestTimeout: requestTimeoutMs,
    retry: { retries },
  };
  if (config.runtime !== KAFKA_RUNTIME_IDS.MSK) return options;

  const generateToken = tokenGenerator || await loadMskTokenGenerator();
  options.logLevel = 0;
  options.ssl = true;
  options.sasl = {
    mechanism: "oauthbearer",
    oauthBearerProvider: async () => {
      const response = await generateToken({ region: config.region });
      if (!response?.token) {
        throw new KafkaRuntimeError(
          "KAFKA_AUTHENTICATION_FAILED",
          "Amazon MSK IAM token generation failed.",
          { runtime: config.runtime, stage: "authentication", status: 403 },
        );
      }
      return { value: response.token };
    },
  };
  return options;
}

export function kafkaDefaultBroker(env = process.env) {
  return resolveKafkaRuntimeConfig({ env }).brokers.join(",");
}

export function describeKafkaEndpoint(config) {
  if (config.runtime === KAFKA_RUNTIME_IDS.MSK) {
    return `Amazon MSK Serverless (${config.brokers.length} bootstrap broker${config.brokers.length === 1 ? "" : "s"})`;
  }
  return config.brokers.join(",");
}

export function validateKafkaTopic(topic, config) {
  const value = String(topic || "").trim();
  if (!TOPIC_PATTERN.test(value) || value === "." || value === "..") {
    throw new KafkaRuntimeError(
      "KAFKA_TOPIC_NAME_INVALID",
      "Kafka topic name is invalid.",
      { details: { topic: value }, runtime: config?.runtime, stage: "topic-policy", status: 400 },
    );
  }
  if (config?.topicPrefix && !value.startsWith(`${config.topicPrefix}.`)) {
    throw new KafkaRuntimeError(
      "KAFKA_TOPIC_NAMESPACE_INVALID",
      `Kafka topic must use the ${config.topicPrefix}. namespace.`,
      {
        details: { expectedPrefix: `${config.topicPrefix}.`, topic: value },
        runtime: config.runtime,
        stage: "topic-policy",
        status: 422,
      },
    );
  }
  return value;
}

export function kafkaTopicCreationSpec(topic, config) {
  const validatedTopic = validateKafkaTopic(topic, config);
  return {
    configEntries: [{ name: "retention.ms", value: String(config.topicPolicy.retentionMs) }],
    numPartitions: config.topicPolicy.minPartitions,
    topic: validatedTopic,
  };
}

export function assertKafkaTopicPolicy({ config, configEntries = [], metadata, topic }) {
  const validatedTopic = validateKafkaTopic(topic, config);
  const topicMetadata = metadata?.topics?.find((item) => item?.name === validatedTopic);
  if (!topicMetadata || !Array.isArray(topicMetadata.partitions) || topicMetadata.partitions.length === 0) {
    throw new KafkaRuntimeError(
      "KAFKA_TOPIC_NOT_FOUND",
      "Kafka topic was not found or has no partitions.",
      { details: { topic: validatedTopic }, runtime: config.runtime, stage: "topic-policy", status: 404 },
    );
  }
  const retentionEntry = configEntries.find((entry) => entry?.configName === "retention.ms" || entry?.name === "retention.ms");
  const actualRetentionMs = retentionEntry?.configValue ?? retentionEntry?.value;
  const actualPartitions = topicMetadata.partitions.length;
  const mismatches = [];
  if (actualPartitions < config.topicPolicy.minPartitions) {
    mismatches.push({
      actual: actualPartitions,
      expectedMinimum: config.topicPolicy.minPartitions,
      field: "partitions",
    });
  }
  if (String(actualRetentionMs ?? "") !== String(config.topicPolicy.retentionMs)) {
    mismatches.push({
      actual: actualRetentionMs ?? null,
      expected: String(config.topicPolicy.retentionMs),
      field: "retention.ms",
    });
  }
  if (config.topicPolicy.enforced && mismatches.length > 0) {
    throw new KafkaRuntimeError(
      "KAFKA_TOPIC_POLICY_MISMATCH",
      "Kafka topic does not match the configured partition/retention policy.",
      { details: { mismatches, topic: validatedTopic }, runtime: config.runtime, stage: "topic-policy", status: 422 },
    );
  }
  return {
    mismatches,
    partitions: actualPartitions,
    retentionMs: actualRetentionMs === undefined || actualRetentionMs === null ? null : Number(actualRetentionMs),
    topic: validatedTopic,
  };
}

export function assertKafkaTopicRecreationAllowed(config, recreateTopic) {
  if (recreateTopic && config.runtime === KAFKA_RUNTIME_IDS.MSK) {
    throw new KafkaRuntimeError(
      "KAFKA_TOPIC_RECREATION_FORBIDDEN",
      "Amazon MSK topics cannot be deleted and recreated by the replay producer.",
      { runtime: config.runtime, stage: "topic-policy", status: 422 },
    );
  }
}

export function normalizeKafkaError(error, { runtime, stage } = {}) {
  if (error instanceof KafkaRuntimeError) return error;
  if (error?.code === "KAFKA_TOPIC_NOT_FOUND") {
    return new KafkaRuntimeError(
      "KAFKA_TOPIC_NOT_FOUND",
      "Kafka topic was not found.",
      { runtime, stage, status: 404 },
    );
  }
  const text = `${error?.name || ""} ${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  if (/(unknown_topic|unknown topic|topic.*not exist|does not host this topic)/.test(text)) {
    return new KafkaRuntimeError(
      "KAFKA_TOPIC_NOT_FOUND",
      "Kafka topic was not found.",
      { runtime, stage, status: 404 },
    );
  }
  if (/(sasl|oauth|authentication|authorization|access denied|not authorized|forbidden)/.test(text)) {
    return new KafkaRuntimeError(
      "KAFKA_AUTHENTICATION_FAILED",
      "Kafka IAM authentication or authorization failed.",
      { runtime, stage, status: 403 },
    );
  }
  if (/(timeout|timed out|etimedout|econnrefused|enotfound|ehostunreach|enetunreach|connection.*closed|failed to connect)/.test(text)) {
    return new KafkaRuntimeError(
      "KAFKA_CONNECTION_TIMEOUT",
      "Kafka connection failed or timed out.",
      { runtime, stage, status: 504 },
    );
  }
  return new KafkaRuntimeError(
    "KAFKA_OPERATION_FAILED",
    "Kafka operation failed.",
    { runtime, stage, status: 502 },
  );
}

export function serializeKafkaError(error, context = {}) {
  const normalized = normalizeKafkaError(error, context);
  return {
    code: normalized.code,
    ...(normalized.details ? { details: normalized.details } : {}),
    message: normalized.message,
    ...(normalized.runtime ? { runtime: normalized.runtime } : {}),
    ...(normalized.stage ? { stage: normalized.stage } : {}),
    status: normalized.status,
  };
}

function canonicalKafkaRuntime(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["redpanda", "local", "docker", "kafka"].includes(normalized)) return KAFKA_RUNTIME_IDS.REDPANDA;
  if (["msk", "amazon-msk", "msk-serverless"].includes(normalized)) return KAFKA_RUNTIME_IDS.MSK;
  throw configurationError(`Unsupported Kafka Runtime: ${value}`);
}

function canonicalEnvironment(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const aliases = { development: "dev", production: "prod" };
  const result = aliases[normalized] || normalized;
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(result)) {
    throw configurationError("ASKLAKE_KAFKA_ENVIRONMENT must be a lowercase environment label.");
  }
  return result;
}

function parseBrokerList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const result = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  if (result.length === 0) throw configurationError("At least one Kafka bootstrap broker is required.");
  for (const broker of result) {
    if (broker.includes("://") || /[\s/@]/.test(broker) || !broker.includes(":")) {
      throw configurationError("Kafka bootstrap brokers must use host:port without credentials or a URL scheme.");
    }
  }
  return result;
}

function validateOptionalTopicPrefix(value, runtime) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  return validateTopicPrefix(String(value).trim(), runtime);
}

function validateTopicPrefix(value, runtime) {
  if (!TOPIC_PREFIX_PATTERN.test(value) || value.endsWith(".") || value.includes("..")) {
    throw configurationError("ASKLAKE_KAFKA_TOPIC_PREFIX is invalid.", runtime);
  }
  return value;
}

function validateClientId(value) {
  const clientId = String(value || "asklake-kafka-client").trim();
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(clientId)) {
    throw configurationError("Kafka clientId is invalid.");
  }
  return clientId;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || String(value).trim().toLowerCase() === "true") return true;
  if (value === false || String(value).trim().toLowerCase() === "false") return false;
  throw configurationError(`Expected a boolean value, received: ${value}`);
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw configurationError(`${label} must be a positive integer.`);
  return parsed;
}

function nonnegativeInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw configurationError(`${label} must be a non-negative integer.`);
  return parsed;
}

function firstPresent(...values) {
  return values.find((value) => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== "");
}

function configurationError(message, runtime) {
  return new KafkaRuntimeError(
    "KAFKA_RUNTIME_CONFIGURATION_INVALID",
    message,
    { runtime, stage: "configuration", status: 500 },
  );
}

async function loadMskTokenGenerator() {
  const signerModule = await import("aws-msk-iam-sasl-signer-js");
  const signer = signerModule.default ?? signerModule;
  if (typeof signer.generateAuthToken !== "function") {
    throw configurationError("AWS MSK IAM signer does not export generateAuthToken.", KAFKA_RUNTIME_IDS.MSK);
  }
  return signer.generateAuthToken;
}
