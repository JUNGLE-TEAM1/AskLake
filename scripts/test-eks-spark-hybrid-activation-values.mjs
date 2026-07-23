#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_CACHE_MAX_SOURCE_BYTES,
  buildSparkHybridActivationValues,
  runtimeConfigDataHash,
} from "./build-eks-spark-hybrid-activation-values.mjs";


const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (component, character) => (
  `000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/asklake/dev/${component}@${digest(character)}`
);


function fixture() {
  return {
    runtime: {
      namespace: "asklake-dev",
      configMap: {
        name: "asklake-runtime",
        data: {
          ASKLAKE_SPARK_KUBERNETES_IMAGE: image("spark-runtime", "1"),
          ASKLAKE_SPARK_RESOURCE_PLANNER_MODE: "shadow",
          AWS_REGION: "ap-northeast-2",
        },
      },
    },
    web: {
      backend: {
        image: image("backend", "2"),
        runtimeConfigRevision: "prior",
      },
      frontend: { image: image("frontend", "3") },
    },
    receipt: {
      gitRevision: "a".repeat(40),
      images: {
        backend: image("backend", "4"),
        sparkRuntime: image("spark-runtime", "5"),
      },
    },
  };
}


test("activates the 10GiB direct-cache threshold with one Backend/Spark revision", () => {
  const { runtime, web, receipt } = fixture();
  const result = buildSparkHybridActivationValues(runtime, web, receipt);

  assert.equal(
    result.runtimeValues.configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES,
    DIRECT_CACHE_MAX_SOURCE_BYTES,
  );
  assert.equal(
    result.runtimeValues.configMap.data.ASKLAKE_SPARK_KUBERNETES_IMAGE,
    receipt.images.sparkRuntime,
  );
  assert.equal(result.webValues.backend.image, receipt.images.backend);
  assert.match(result.runtimeConfigRevision, /^spark-hybrid-[a-f0-9]{16}$/);
  assert.equal(result.webValues.backend.runtimeConfigRevision, result.runtimeConfigRevision);
  assert.equal(result.runtimeDataHash, runtimeConfigDataHash(result.runtimeValues));
  assert.equal(result.runtimeValues.configMap.data.ASKLAKE_SPARK_RESOURCE_PLANNER_MODE, "shadow");
  assert.equal(result.webValues.frontend.image, web.frontend.image);
  assert.equal(runtime.configMap.data.ASKLAKE_SPARK_DIRECT_CACHE_MAX_SOURCE_BYTES, undefined);
  assert.equal(web.backend.runtimeConfigRevision, "prior");
});


test("runtime revision changes when any runtime value changes", () => {
  const left = fixture();
  const right = fixture();
  right.runtime.configMap.data.AWS_REGION = "us-west-2";

  assert.notEqual(
    buildSparkHybridActivationValues(left.runtime, left.web, left.receipt).runtimeConfigRevision,
    buildSparkHybridActivationValues(right.runtime, right.web, right.receipt).runtimeConfigRevision,
  );
});


test("rejects mutable or cross-component candidate images", () => {
  const mutable = fixture();
  mutable.receipt.images.backend = "example.invalid/backend:latest";
  assert.throws(
    () => buildSparkHybridActivationValues(mutable.runtime, mutable.web, mutable.receipt),
    /backend image must be an immutable dev ECR reference/,
  );

  const wrongSpark = fixture();
  wrongSpark.receipt.images.sparkRuntime = image("backend", "6");
  assert.throws(
    () => buildSparkHybridActivationValues(
      wrongSpark.runtime,
      wrongSpark.web,
      wrongSpark.receipt,
    ),
    /spark-runtime image must be an immutable dev ECR reference/,
  );
});
