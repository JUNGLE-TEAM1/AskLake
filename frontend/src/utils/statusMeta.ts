import type { CatalogDataset, DashboardStatus, JobStatus } from "../types";

export const jobStatusMeta: Record<JobStatus, { className: string; label: string; summaryLabel: string }> = {
  scheduled: { className: "scheduled", label: "실행 대기", summaryLabel: "READY" },
  failed: { className: "failed", label: "실패", summaryLabel: "FAILED" },
  running: { className: "running", label: "실행 중", summaryLabel: "RUNNING" },
  paused: { className: "paused", label: "실행 일시정지", summaryLabel: "PAUSED" },
  canceled: { className: "canceled", label: "취소됨", summaryLabel: "CANCELED" },
  stopped: { className: "paused", label: "자동 실행 중지", summaryLabel: "STOPPED" },
};

export const datasetStatusMeta: Record<CatalogDataset["status"], { className: string; label: string }> = {
  available: { className: "available", label: "사용 가능" },
  approval_required: { className: "approval", label: "승인 필요" },
};

export const dashboardStatusMeta: Record<DashboardStatus, { label: string }> = {
  draft: { label: "Draft" },
  published: { label: "Published" },
};

export function normalizeJobStatus(status: string): JobStatus {
  const statusMap: Record<string, JobStatus> = {
    scheduled: "scheduled",
    "스케줄됨": "scheduled",
    "실행 대기": "scheduled",
    failed: "failed",
    "실패": "failed",
    running: "running",
    "실행 중": "running",
    paused: "paused",
    "일시정지": "paused",
    "실행 일시정지": "paused",
    canceled: "canceled",
    "취소됨": "canceled",
    stopped: "stopped",
    "스케줄 중지": "stopped",
    "스케줄 중지됨": "stopped",
    "스케줄 일시중지": "stopped",
  };

  const normalizedStatus = statusMap[status];
  if (normalizedStatus) return normalizedStatus;

  console.warn(`[AskLake API] Unknown job status "${status}", falling back to "scheduled".`);
  return "scheduled";
}

export function normalizeDatasetStatus(status: string): CatalogDataset["status"] {
  const statusMap: Record<string, CatalogDataset["status"]> = {
    available: "available",
    "사용 가능": "available",
    approval_required: "approval_required",
    "승인 필요": "approval_required",
  };

  const normalizedStatus = statusMap[status];
  if (normalizedStatus) return normalizedStatus;

  console.warn(`[AskLake API] Unknown dataset status "${status}", falling back to "available".`);
  return "available";
}

export function normalizeDashboardStatus(status: string): DashboardStatus {
  const statusMap: Record<string, DashboardStatus> = {
    draft: "draft",
    Draft: "draft",
    published: "published",
    Published: "published",
  };

  const normalizedStatus = statusMap[status];
  if (normalizedStatus) return normalizedStatus;

  console.warn(`[AskLake API] Unknown dashboard status "${status}", falling back to "draft".`);
  return "draft";
}
