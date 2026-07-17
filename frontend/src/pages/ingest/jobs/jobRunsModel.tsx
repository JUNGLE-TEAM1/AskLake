

import type { KafkaContinuousBatch, KafkaContinuousSessionStatus } from "../../../types";

import { type StatusBadgeTone } from "@/components/ui/status-badge";

import type { AuditResult, JobCommand, JobExecutionEvidence, JobRowData } from "../../../types";

export type JobRunsPageProps = {
  catalogDatasetId?: string;
  catalogRowCount?: string;
  evidence?: JobExecutionEvidence;
  job: JobRowData;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onCommand: (job: JobRowData, command: JobCommand) => void;
  onRefresh?: () => void;
};

export const activeContinuousSessionStatuses = new Set<KafkaContinuousSessionStatus>(["starting", "running", "stopping"]);

export const continuousSessionStatusMeta: Record<KafkaContinuousSessionStatus, { label: string; tone: StatusBadgeTone }> = {
  failed: { label: "실패", tone: "danger" },
  running: { label: "실행 중", tone: "success" },
  starting: { label: "시작 중", tone: "default" },
  stopped: { label: "종료", tone: "muted" },
  stopping: { label: "종료 중", tone: "default" },
};

export const continuousBatchStatusMeta: Record<KafkaContinuousBatch["status"], { label: string; tone: StatusBadgeTone }> = {
  failed: { label: "실패", tone: "danger" },
  running: { label: "진행", tone: "default" },
  success: { label: "성공", tone: "success" },
};

export type ContinuousDagSelection =
  | { id: string; kind: "session" }
  | { id: number; kind: "batch" };
