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
