export type AuditResult = "success" | "failed" | "forbidden";
export type AuditTargetType = "etl_job" | "dataset" | "dashboard" | "ai_module" | "admin_module" | "ui";

export type AuditEntry = {
  action: string;
  actor_id: string;
  api_path: string;
  created_at: string;
  request_id: string;
  result: AuditResult;
  target_id: string;
  target_type: AuditTargetType;
};

export type ApiErrorResponse = {
  detail?: unknown;
  error: {
    code: string;
    details?: Record<string, unknown> | null;
    message: string;
  };
};

export class ApiError extends Error {
  code: string;
  status: number;

  constructor({ code, message, status }: { code: string; message: string; status: number }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}
