#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAwsRegionFromKubeconfig,
  parseCpuMillicores,
  parseDeployment,
  parseEvents,
  parseHpa,
  parseLoadStatus,
  parseManagedInstances,
  parseMemoryBytes,
  parsePodMetrics,
  parsePods,
  sanitizeFailure,
} from "./watch-eks-day17-scale.mjs";

test("AWS region is discovered from kubeconfig without exposing the context", () => {
  assert.equal(
    parseAwsRegionFromKubeconfig({
      "current-context": "arn:aws:eks:ap-northeast-2:123456789012:cluster/sensitive",
      users: [{ user: { exec: { args: ["eks", "get-token", "--region", "ap-northeast-2"] } } }],
    }),
    "ap-northeast-2",
  );
  assert.equal(parseAwsRegionFromKubeconfig({ users: [] }), null);
});

test("HPA and Deployment parsers expose only aggregate scaling state", () => {
  const hpa = parseHpa({
    spec: {
      minReplicas: 2,
      maxReplicas: 6,
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { averageUtilization: 60 } },
        },
      ],
    },
    status: {
      currentReplicas: 2,
      desiredReplicas: 4,
      currentMetrics: [
        {
          type: "Resource",
          resource: { name: "cpu", current: { averageUtilization: 127 } },
        },
      ],
      conditions: [{ type: "AbleToScale", status: "True", message: "secret resource name" }],
    },
  });
  assert.deepEqual(hpa, {
    state: "deployed",
    currentReplicas: 2,
    desiredReplicas: 4,
    minReplicas: 2,
    maxReplicas: 6,
    currentCpuPercent: 127,
    targetCpuPercent: 60,
    conditions: [{ type: "AbleToScale", status: "True" }],
  });
  assert.deepEqual(
    parseDeployment({
      spec: { replicas: 4 },
      status: { updatedReplicas: 4, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 1 },
    }),
    {
      state: "available",
      desired: 4,
      updated: 4,
      ready: 3,
      available: 3,
      unavailable: 1,
    },
  );
});

test("Pod and metrics parsers aggregate FastAPI and Spark without returning identifiers", () => {
  const pods = parsePods({
    items: [
      {
        metadata: { name: "backend-sensitive-id", labels: { "app.kubernetes.io/component": "backend" } },
        spec: { containers: [{ name: "fastapi" }] },
        status: { phase: "Running", containerStatuses: [{ ready: true }] },
      },
      {
        metadata: {
          name: "driver-sensitive-id",
          labels: { "spark-role": "driver", "asklake.io/run-id": "run-secret" },
        },
        status: { phase: "Running", containerStatuses: [{ ready: true }] },
      },
      {
        metadata: {
          name: "executor-sensitive-id",
          labels: { "spark-role": "executor", "asklake.io/run-id": "run-secret" },
          deletionTimestamp: "2026-07-17T00:00:00Z",
        },
        status: { phase: "Running", containerStatuses: [{ ready: false }] },
      },
    ],
  });
  assert.equal(pods.backend.total, 1);
  assert.equal(pods.backend.ready, 1);
  assert.equal(pods.spark.runs, 1);
  assert.equal(pods.spark.drivers, 1);
  assert.equal(pods.spark.executors, 1);
  assert.equal(pods.spark.terminating, 1);

  const metrics = parsePodMetrics(
    {
      items: [
        {
          metadata: { name: "backend-sensitive-id" },
          containers: [{ usage: { cpu: "125m", memory: "256Mi" } }],
        },
        {
          metadata: { name: "driver-sensitive-id" },
          containers: [{ usage: { cpu: "150000000n", memory: "1Gi" } }],
        },
      ],
    },
    pods.backendNames,
    pods.sparkNames,
  );
  assert.equal(metrics.backend.cpuMillicores, 125);
  assert.equal(metrics.backend.memoryBytes, 256 * 1024 ** 2);
  assert.equal(metrics.spark.cpuMillicores, 150);
  assert.equal(metrics.spark.memoryBytes, 1024 ** 3);
});

test("resource quantity parsers normalize Kubernetes CPU and memory units", () => {
  assert.equal(parseCpuMillicores("1"), 1000);
  assert.equal(parseCpuMillicores("250m"), 250);
  assert.equal(parseCpuMillicores("250000u"), 250);
  assert.equal(parseCpuMillicores("250000000n"), 250);
  assert.equal(parseMemoryBytes("2Gi"), 2 * 1024 ** 3);
  assert.equal(parseMemoryBytes("500M"), 500_000_000);
});

test("managed instance parser keeps expected pool, type, state and count only", () => {
  const groups = parseManagedInstances({
    Reservations: [
      {
        Instances: [
          {
            InstanceId: "i-sensitive",
            InstanceType: "m7i-flex.large",
            State: { Name: "running" },
            Tags: [
              { Key: "eks:kubernetes-node-pool-name", Value: "asklake-general" },
              { Key: "Name", Value: "sensitive-node-name" },
            ],
          },
          {
            InstanceId: "i-sensitive-2",
            InstanceType: "m7i-flex.large",
            State: { Name: "running" },
            Tags: [{ Key: "eks:kubernetes-node-pool-name", Value: "unexpected-sensitive-pool" }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(groups, [
    { pool: "asklake-general", type: "m7i-flex.large", state: "running", count: 1 },
    { pool: "other", type: "m7i-flex.large", state: "running", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(groups), /i-sensitive|sensitive-node|unexpected-sensitive/);
});

test("event parser filters by time and reason and removes object names and messages", () => {
  const events = parseEvents(
    {
      items: [
        {
          eventTime: "2026-07-17T03:59:00Z",
          reason: "FailedScheduling",
          type: "Warning",
          message: "contains a sensitive node and account",
          involvedObject: { kind: "Pod", name: "sensitive-pod" },
          count: 2,
        },
        {
          eventTime: "2026-07-17T03:58:00Z",
          reason: "Pulled",
          involvedObject: { kind: "Pod", name: "ignored" },
        },
        {
          eventTime: "2026-07-17T03:30:00Z",
          reason: "Scheduled",
          involvedObject: { kind: "Pod", name: "too-old" },
        },
      ],
    },
    new Date("2026-07-17T04:00:00Z"),
  );
  assert.deepEqual(events, [
    {
      observedAt: "2026-07-17T03:59:00Z",
      reason: "FailedScheduling",
      type: "Warning",
      kind: "Pod",
      count: 2,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /sensitive|account/);
});

test("load status and failures are bounded and sanitized", () => {
  assert.deepEqual(
    parseLoadStatus({
      phase: "ramp-200<script>",
      targetRps: 200,
      totalRequests: 1000,
      non2xx: 3,
      serverErrors: 1,
      p95Ms: 123.7,
      endpoint: "https://sensitive.example",
    }),
    {
      state: "connected",
      phase: "ramp-200?script?",
      targetRps: 200,
      totalRequests: 1000,
      non2xx: 3,
      serverErrors: 1,
      p95Ms: 124,
    },
  );
  assert.equal(
    sanitizeFailure({
      stderr:
        'Error from server (Forbidden): arn:aws:iam::123456789012:user/sensitive cannot list resource "nodes"',
    }),
    "RBAC forbidden",
  );
  assert.equal(
    sanitizeFailure({ stderr: "An error occurred (AccessDenied) for account 123456789012" }),
    "AWS access denied",
  );
});
