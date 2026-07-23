import { ApiError } from "../../types/audit.ts";
import { ApiRequestTimeoutError } from "../../services/apiClient.ts";

export type SqlValidationFailureKind = "transport" | "validation";

export type SqlValidationFailure = {
  kind: SqlValidationFailureKind;
  message: string;
};

export function describeSqlValidationFailure(error: unknown): SqlValidationFailure {
  if (error instanceof ApiError && error.code === "API_NETWORK_ERROR") {
    return { kind: "transport", message: error.message };
  }
  if (error instanceof ApiRequestTimeoutError) {
    return {
      kind: "transport",
      message: "API 서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
    };
  }
  return {
    kind: "validation",
    message: error instanceof Error ? error.message : "Trino SQL 검증에 실패했습니다.",
  };
}
