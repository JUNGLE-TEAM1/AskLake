import SnappyCodec from "kafkajs-snappy";

let configuredKafkaJs;

export async function loadKafkaJs() {
  if (configuredKafkaJs) return configuredKafkaJs;
  const kafkaJsModule = await import("kafkajs");
  const kafkaJs = kafkaJsModule.default ?? kafkaJsModule;
  kafkaJs.CompressionCodecs[kafkaJs.CompressionTypes.Snappy] = SnappyCodec;
  configuredKafkaJs = kafkaJs;
  return configuredKafkaJs;
}

export async function kafkaSecurityOptions(environment = process.env) {
  const mode = String(environment.ASKLAKE_KAFKA_AUTH_MODE || "none").trim().toLowerCase();
  if (!mode || mode === "none" || mode === "plaintext") return {};
  if (mode !== "iam") throw new Error(`Unsupported ASKLAKE_KAFKA_AUTH_MODE: ${mode}`);
  const region = String(environment.AWS_REGION || environment.AWS_DEFAULT_REGION || "").trim();
  if (!region) throw new Error("AWS_REGION is required for MSK IAM authentication");
  const { generateAuthToken } = await import("aws-msk-iam-sasl-signer-js");
  return {
    ssl: true,
    sasl: {
      mechanism: "oauthbearer",
      oauthBearerProvider: async () => {
        const response = await generateAuthToken({ region });
        return { value: response.token };
      },
    },
  };
}

export function validateManagedKafkaSourceBoundary({ broker, topic }, environment = process.env) {
  const mode = String(environment.ASKLAKE_KAFKA_AUTH_MODE || "none").trim().toLowerCase();
  if (mode !== "iam") return;
  const configuredBroker = String(environment.ASKLAKE_KAFKA_BROKER || "").trim();
  const allowedTopicPrefixes = String(environment.ASKLAKE_KAFKA_ALLOWED_TOPIC_PREFIXES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!configuredBroker || allowedTopicPrefixes.length === 0) {
    throw kafkaBoundaryError(
      "KAFKA_MANAGED_BOUNDARY_NOT_CONFIGURED",
      "MSK IAM requires a deployment-owned broker and at least one allowed topic prefix.",
    );
  }
  if (canonicalBrokers(broker) !== canonicalBrokers(configuredBroker)) {
    throw kafkaBoundaryError(
      "KAFKA_BROKER_OUTSIDE_MANAGED_BOUNDARY",
      "Kafka broker must match the broker owned by this EKS deployment.",
    );
  }
  if (!allowedTopicPrefixes.some((prefix) => String(topic || "").startsWith(prefix))) {
    throw kafkaBoundaryError(
      "KAFKA_TOPIC_OUTSIDE_MANAGED_BOUNDARY",
      "Kafka topic is outside the topic namespace allowed by this EKS deployment.",
    );
  }
}

function canonicalBrokers(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function kafkaBoundaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
