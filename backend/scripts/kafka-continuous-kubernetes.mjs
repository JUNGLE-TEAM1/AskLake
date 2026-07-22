/** Build the Spark Operator resource without coupling it to worker lifecycle I/O. */

import { sparkApplicationName } from "./spark-kubernetes-client.mjs";

export function buildContinuousSparkApplication({
  jobId,
  runtime,
  workerAttemptId,
  runtimeEnvironment,
  packages,
  environment = process.env,
}) {
  const labels = {
    "app.kubernetes.io/managed-by": "asklake-continuous-worker",
    "asklake.job-id": safeSegment(jobId),
    "asklake.worker-attempt-id": workerAttemptId,
  };
  const env = kubernetesEnvironment(runtimeEnvironment, environment);
  const workload = {
    labels,
    env,
    nodeSelector: jsonObjectEnvironment(
      environment.ASKLAKE_SPARK_KUBERNETES_NODE_SELECTOR,
      "ASKLAKE_SPARK_KUBERNETES_NODE_SELECTOR",
    ),
    tolerations: kubernetesTolerations(environment),
  };
  return {
    apiVersion: "sparkoperator.k8s.io/v1beta2",
    kind: "SparkApplication",
    metadata: { name: sparkApplicationName(jobId), namespace: runtime.namespace, labels },
    spec: {
      type: "Python",
      pythonVersion: "3",
      mode: "cluster",
      image: runtime.image,
      imagePullPolicy: environment.ASKLAKE_SPARK_KUBERNETES_IMAGE_PULL_POLICY || "IfNotPresent",
      mainApplicationFile: environment.ASKLAKE_SPARK_CONTINUOUS_SCRIPT || "/opt/asklake/scripts/kafka_continuous_stream.py",
      sparkVersion: environment.ASKLAKE_SPARK_KUBERNETES_VERSION || "4.0.1",
      restartPolicy: { type: "Never" },
      deps: packages.length ? { packages } : undefined,
      hadoopConf: kubernetesHadoopConf(environment),
      sparkConf: {
        "spark.sql.shuffle.partitions": String(positiveInt(environment.ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS, 4)),
        "spark.sql.streaming.stopGracefullyOnShutdown": "true",
        "spark.jars.ivy": environment.ASKLAKE_SPARK_KUBERNETES_IVY_DIR || "/tmp/.ivy2",
        "spark.kubernetes.executor.deleteOnTermination": "true",
      },
      driver: {
        cores: positiveInt(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES, 1),
        memory: environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_MEMORY || "2g",
        serviceAccount: runtime.serviceAccount,
        ...workload,
      },
      executor: {
        instances: positiveInt(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES, 2),
        cores: positiveInt(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES, 1),
        memory: environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY || "2g",
        ...workload,
      },
    },
  };
}

function kubernetesEnvironment(runtimeEnvironment, environment) {
  const secretName = String(
    environment.ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET_NAME || "asklake-spark-runtime",
  ).trim();
  const secretKeys = {
    ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD: environment.ASKLAKE_SPARK_KUBERNETES_ICEBERG_JDBC_PASSWORD_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD",
    ASKLAKE_SPARK_ICEBERG_JDBC_URL: environment.ASKLAKE_SPARK_KUBERNETES_ICEBERG_JDBC_URL_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_URL",
    ASKLAKE_SPARK_ICEBERG_JDBC_USER: environment.ASKLAKE_SPARK_KUBERNETES_ICEBERG_JDBC_USER_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_USER",
  };
  return Object.entries(runtimeEnvironment).map(([name, value]) => {
    const secretKey = secretKeys[name];
    return secretKey
      ? { name, valueFrom: { secretKeyRef: { name: secretName, key: secretKey } } }
      : { name, value: String(value) };
  });
}

function kubernetesHadoopConf(environment) {
  return {
    "fs.s3a.aws.credentials.provider": String(
      environment.ASKLAKE_SPARK_KUBERNETES_S3A_CREDENTIALS_PROVIDER
        || "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider",
    ),
    ...jsonObjectEnvironment(
      environment.ASKLAKE_SPARK_KUBERNETES_HADOOP_CONF,
      "ASKLAKE_SPARK_KUBERNETES_HADOOP_CONF",
    ),
  };
}

function kubernetesTolerations(environment) {
  const raw = String(environment.ASKLAKE_SPARK_KUBERNETES_TOLERATIONS || "").trim();
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("must be a JSON array of Kubernetes toleration objects");
    }
    return value;
  } catch (error) {
    throw new Error(`ASKLAKE_SPARK_KUBERNETES_TOLERATIONS ${error.message}`);
  }
}

function jsonObjectEnvironment(value, name) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  } catch (error) {
    throw new Error(`${name} ${error.message}`);
  }
}

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
