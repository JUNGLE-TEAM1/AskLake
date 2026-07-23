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
