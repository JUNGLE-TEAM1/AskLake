import { KAFKA_RUNTIME_IDS, KafkaRuntimeError, createKafkaClient, resolveKafkaRuntimeConfig, serializeKafkaError } from "../src/kafkaRuntime.mjs";
import { runKafkaRoundtripProbe } from "../src/kafkaRoundtripProbe.mjs";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

try {
  const config = resolveKafkaRuntimeConfig();
  if (config.runtime !== KAFKA_RUNTIME_IDS.MSK) {
    throw new KafkaRuntimeError(
      "KAFKA_RUNTIME_CONFIGURATION_INVALID",
      "MSK probe requires ASKLAKE_KAFKA_RUNTIME=msk.",
      { runtime: config.runtime, stage: "configuration", status: 500 },
    );
  }
  const topic = options.topic || process.env.ASKLAKE_MSK_PROBE_TOPIC || `${config.topicPrefix}.probe`;
  const timeoutMs = positiveInteger(
    options.timeoutMs || process.env.ASKLAKE_MSK_PROBE_TIMEOUT_MS || 15000,
    "timeout-ms",
  );
  const { client, kafkaJs } = await createKafkaClient({
    clientId: "asklake-msk-roundtrip-probe",
    config,
  });
  const result = await runKafkaRoundtripProbe({
    client,
    config,
    createTopic: Boolean(options.createTopic),
    kafkaJs,
    timeoutMs,
    topic,
  });
  console.log(`ASKLAKE_MSK_PROBE_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.error(`ASKLAKE_MSK_PROBE_ERROR=${JSON.stringify(serializeKafkaError(error, { stage: "roundtrip-probe" }))}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--create-topic") {
      parsed.createTopic = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown positional argument: ${arg}`);
    const equalsIndex = arg.indexOf("=");
    const key = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (key === "topic") parsed.topic = value;
    else if (key === "timeout-ms") parsed.timeoutMs = value;
    else throw new Error(`Unknown option: --${key}`);
    if (equalsIndex === -1) index += 1;
  }
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer`);
  return parsed;
}

function printUsage() {
  console.log(`Usage: npm run kafka:msk-probe -- [options]

  --topic <topic>       Environment-prefixed probe topic (default: <prefix>.probe)
  --timeout-ms <ms>     Bounded consumer timeout (default: 15000)
  --create-topic        Create the topic only when it does not exist
  --help, -h            Print this help

The probe never deletes a topic or increases partitions. It uses IAM/TLS and the AWS default credential chain.`);
}
