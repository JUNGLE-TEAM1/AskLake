export type AuditResult = "success" | "failed" | "forbidden";
export type AuditTargetType = "etl_job" | "dataset" | "dashboard" | "ai_module" | "admin_module" | "ui" | "auth" | "user" | "group";

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
    diagnosticId?: string | null;
    message: string;
    operatorMessage?: string | null;
    retryable?: boolean;
    stage?: string;
    userMessage?: string | null;
  };
};

export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown> | null;
  diagnosticId?: string;
  retryable: boolean;
  stage: string;
  status: number;

  constructor({ code, details, diagnosticId, message, retryable = false, stage = "api", status }: { code: string; details?: Record<string, unknown> | null; diagnosticId?: string; message: string; retryable?: boolean; stage?: string; status: number }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.diagnosticId = diagnosticId;
    this.retryable = retryable;
    this.stage = stage;
    this.status = status;
  }
}
