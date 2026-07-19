import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/types/audit.ts";
import {
  ApiRequestTimeoutError,
  request,
} from "../src/services/apiClient.ts";
import { describeSqlValidationFailure } from "../src/pages/sql/sqlPreflightErrors.ts";

test("browser fetch network failures become retryable API transport errors", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    request("/api/query/validate", { method: "POST", body: { query: "SELECT 1" } }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "API_NETWORK_ERROR");
      assert.equal(error.stage, "transport");
      assert.equal(error.status, 0);
      assert.equal(error.retryable, true);
      assert.equal(error.message, "API 서버에 연결할 수 없습니다. 현재 서비스 주소와 네트워크 상태를 확인해 주세요.");
      assert.deepEqual(error.details, { path: "/api/query/validate" });
      return true;
    },
  );
});

test("SQL preflight distinguishes transport failures from Trino validation failures", () => {
  const transportFailure = describeSqlValidationFailure(new ApiError({
    code: "API_NETWORK_ERROR",
    message: "API 서버에 연결할 수 없습니다.",
    retryable: true,
    stage: "transport",
    status: 0,
  }));
  const timeoutFailure = describeSqlValidationFailure(new ApiRequestTimeoutError(3_000));
  const validationFailure = describeSqlValidationFailure(new ApiError({
    code: "SQL_VALIDATION_ERROR",
    message: "선택한 테이블 범위에서 SQL을 확인해 주세요.",
    stage: "validation",
    status: 422,
  }));

  assert.deepEqual(transportFailure, {
    kind: "transport",
    message: "API 서버에 연결할 수 없습니다.",
  });
  assert.deepEqual(timeoutFailure, {
    kind: "transport",
    message: "API 서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
  });
  assert.deepEqual(validationFailure, {
    kind: "validation",
    message: "선택한 테이블 범위에서 SQL을 확인해 주세요.",
  });
});
