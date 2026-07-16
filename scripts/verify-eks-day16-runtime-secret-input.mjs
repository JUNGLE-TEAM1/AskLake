#!/usr/bin/env node

import {
  X509Certificate,
} from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const inputPath = resolve(process.cwd(), process.argv[2] ?? 'infra/eks/secrets/dev.runtime-secret-input.json');
const keytoolImage = process.env.ASKLAKE_KEYTOOL_IMAGE ?? 'eclipse-temurin@sha256:9d8dcf999b0bce2453e913823595a5ff2a4e8e9e5d5241b45280d0ff069818ec';
const errors = [];
const fail = (message) => errors.push(message);
const exactKeys = (value, expected, label) => {
  const actual = new Set(Object.keys(value ?? {}));
  for (const key of expected) if (!actual.has(key)) fail(`${label} is missing ${key}`);
  for (const key of actual) if (!expected.has(key)) fail(`${label} contains unapproved key ${key}`);
};
const nonEmptyString = (value, label, minimum = 1) => {
  if (typeof value !== 'string' || value.length < minimum) fail(`${label} must contain at least ${minimum} characters`);
};

let input;
try {
  input = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read private runtime Secret input: ${error.message}`);
  process.exit(1);
}

if ((statSync(inputPath).mode & 0o077) !== 0) fail('private input permissions must not grant group or other access');
exactKeys(input, new Set(['contractVersion', 'namespace', 'sources']), 'input');
if (input.contractVersion !== '1.0') fail('contractVersion must be 1.0');
if (input.namespace !== 'asklake-dev') fail('namespace must be asklake-dev');
exactKeys(input.sources, new Set(['backendPatch', 'spark', 'trino']), 'sources');

const backend = input.sources?.backendPatch ?? {};
const spark = input.sources?.spark ?? {};
const trino = input.sources?.trino ?? {};
exactKeys(backend, new Set([
  'TRINO_AUTH_USERNAME',
  'TRINO_AUTH_PASSWORD',
  'TRINO_MATERIALIZER_USERNAME',
  'TRINO_MATERIALIZER_PASSWORD',
  'TRINO_RESULT_CURSOR_SECRET',
  'TRINO_QUERY_CONFIRMATION_SECRET',
  'trino-ca.pem',
]), 'sources.backendPatch');
exactKeys(spark, new Set([
  'ASKLAKE_SPARK_ICEBERG_JDBC_URL',
  'ASKLAKE_SPARK_ICEBERG_JDBC_USER',
  'ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD',
]), 'sources.spark');
exactKeys(trino, new Set([
  'TRINO_ICEBERG_JDBC_URL',
  'TRINO_ICEBERG_JDBC_USER',
  'TRINO_ICEBERG_JDBC_PASSWORD',
  'TRINO_TLS_KEYSTORE_PASSWORD',
  'TRINO_INTERNAL_SHARED_SECRET',
  'trino-keystore.jks',
  'trino-password.db',
]), 'sources.trino');

if (backend.TRINO_AUTH_USERNAME !== 'asklake-api') fail('query identity must be asklake-api');
if (backend.TRINO_MATERIALIZER_USERNAME !== 'asklake-materializer') fail('materializer identity must be asklake-materializer');
nonEmptyString(backend.TRINO_AUTH_PASSWORD, 'query password', 16);
nonEmptyString(backend.TRINO_MATERIALIZER_PASSWORD, 'materializer password', 16);
if (backend.TRINO_AUTH_PASSWORD === backend.TRINO_MATERIALIZER_PASSWORD) fail('Trino client passwords must be distinct');
nonEmptyString(backend.TRINO_RESULT_CURSOR_SECRET, 'result cursor secret', 32);
nonEmptyString(backend.TRINO_QUERY_CONFIRMATION_SECRET, 'query confirmation secret', 32);
if (backend.TRINO_RESULT_CURSOR_SECRET === backend.TRINO_QUERY_CONFIRMATION_SECRET) fail('Backend Trino signing secrets must be distinct');

const jdbcUrl = spark.ASKLAKE_SPARK_ICEBERG_JDBC_URL;
if (typeof jdbcUrl !== 'string' || !/^jdbc:postgresql:\/\/[^/@\s]+:5432\/iceberg_catalog(?:\?[^\s]*)?$/.test(jdbcUrl)) {
  fail('Iceberg JDBC URL must target the private RDS iceberg_catalog database without embedded credentials');
}
if (jdbcUrl !== trino.TRINO_ICEBERG_JDBC_URL) fail('Spark and Trino JDBC URLs must match');
if (spark.ASKLAKE_SPARK_ICEBERG_JDBC_USER !== 'iceberg_catalog' || trino.TRINO_ICEBERG_JDBC_USER !== 'iceberg_catalog') {
  fail('Spark and Trino must use the isolated iceberg_catalog role');
}
nonEmptyString(spark.ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD, 'Iceberg JDBC password', 16);
if (spark.ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD !== trino.TRINO_ICEBERG_JDBC_PASSWORD) {
  fail('Spark and Trino JDBC passwords must match');
}
nonEmptyString(trino.TRINO_TLS_KEYSTORE_PASSWORD, 'Trino keystore password', 16);
nonEmptyString(trino.TRINO_INTERNAL_SHARED_SECRET, 'Trino internal shared secret', 32);

let passwordDb = '';
let keystore = Buffer.alloc(0);
try {
  for (const [label, encoded] of [
    ['Trino password database', trino['trino-password.db']],
    ['Trino keystore', trino['trino-keystore.jks']],
  ]) {
    if (typeof encoded !== 'string' || encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error(`${label} is not canonical base64`);
    }
  }
  passwordDb = Buffer.from(trino['trino-password.db'], 'base64').toString('utf8');
  keystore = Buffer.from(trino['trino-keystore.jks'], 'base64');
} catch (error) {
  fail(`Trino file values must be valid base64: ${error.message}`);
}
const passwordLines = passwordDb.trim().split('\n');
if (passwordLines.length !== 2 ||
    !passwordLines.some((line) => /^asklake-api:\$2[aby]\$\d{2}\$/.test(line)) ||
    !passwordLines.some((line) => /^asklake-materializer:\$2[aby]\$\d{2}\$/.test(line))) {
  fail('Trino password database must contain exactly the two approved bcrypt identities');
}
for (const line of passwordLines) {
  const cost = Number(line.match(/^.+:\$2[aby]\$(\d{2})\$/)?.[1] ?? 0);
  if (cost < 8) fail('Trino bcrypt cost must be at least 8');
}

let caCertificate;
try {
  caCertificate = new X509Certificate(backend['trino-ca.pem']);
  const san = caCertificate.subjectAltName ?? '';
  for (const hostname of [
    'asklake-trino',
    'asklake-trino.asklake-dev.svc',
    'asklake-trino.asklake-dev.svc.cluster.local',
  ]) {
    if (!san.includes(`DNS:${hostname}`)) fail(`Trino certificate SAN is missing ${hostname}`);
  }
} catch (error) {
  fail(`Trino CA certificate is invalid: ${error.message}`);
}

if (keystore.length < 1024 || keystore.subarray(0, 4).toString('hex') !== 'feedfeed') {
  fail('Trino keystore must be a non-empty JKS file');
} else {
  const directory = mkdtempSync(`${tmpdir()}/asklake-trino-jks-`);
  const keystorePath = resolve(directory, 'trino-keystore.jks');
  try {
    writeFileSync(keystorePath, keystore, { mode: 0o600 });
    const nativeJava = spawnSync('java', ['-version'], { encoding: 'utf8' });
    const invokeKeytool = (arguments_) => nativeJava.status === 0
      ? spawnSync('keytool', arguments_, { encoding: 'utf8' })
      : spawnSync('docker', [
          'run', '--rm', '-v', `${directory}:/work:ro`, keytoolImage, 'keytool',
          ...arguments_.map((argument) => argument === keystorePath ? '/work/trino-keystore.jks' : argument),
        ], { encoding: 'utf8' });
    const listed = invokeKeytool([
      '-list', '-keystore', keystorePath,
      '-storepass', trino.TRINO_TLS_KEYSTORE_PASSWORD,
      '-alias', 'asklake-trino',
    ]);
    if (listed.status !== 0) fail('Trino JKS cannot be opened with the declared password and alias');
    const exported = invokeKeytool([
      '-exportcert', '-rfc', '-keystore', keystorePath,
      '-storepass', trino.TRINO_TLS_KEYSTORE_PASSWORD,
      '-alias', 'asklake-trino',
    ]);
    if (exported.status !== 0) {
      fail('Trino certificate cannot be exported from JKS');
    } else if (caCertificate) {
      const exportedCertificate = new X509Certificate(exported.stdout);
      if (exportedCertificate.fingerprint256 !== caCertificate.fingerprint256) {
        fail('Backend CA and Trino JKS certificates do not match');
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const serialized = JSON.stringify(input);
for (const forbidden of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']) {
  if (serialized.includes(forbidden)) fail(`private input contains forbidden static credential key ${forbidden}`);
}
if (/replace-with|changeme|placeholder|example\.com/i.test(serialized)) fail('private input contains a placeholder value');

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('EKS Day 16 private runtime Secret input verification passed.');
