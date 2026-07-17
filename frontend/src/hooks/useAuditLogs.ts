import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, AuditResult, AuditTargetType } from "../types";

type AuditLogOptions = {
  targetType?: AuditTargetType;
};

export type ToastState = {
  message: string;
  tone: "success" | "info";
};

export function useAuditLogs(actorId?: string | null) {
  const [auditSignal, setAuditSignal] = useState("idle");
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const showToast = useCallback((message: string, tone: ToastState["tone"] = "success") => {
    setToast({ message, tone });
  }, []);

  const writeAuditLog = useCallback((action: string, apiPath: string, targetId: string, result: AuditResult = "success", options: AuditLogOptions = {}) => {
    const entry: AuditEntry = {
      action,
      actor_id: actorId?.trim() || "anonymous",
      api_path: apiPath,
      created_at: new Date().toISOString(),
      request_id: `req_${Date.now()}`,
      result,
      target_id: targetId,
      target_type: options.targetType ?? "etl_job",
    };

    setAuditSignal(action);
    setAuditLogs((logs) => [entry, ...logs].slice(0, 50));

    const debugWindow = window as typeof window & { __asklakeAuditLogs?: AuditEntry[]; __asklakeLastAction?: AuditEntry };
    debugWindow.__asklakeAuditLogs = [entry, ...(debugWindow.__asklakeAuditLogs ?? [])].slice(0, 50);
    debugWindow.__asklakeLastAction = entry;

    console.info("[AskLake API adapter]", entry);
  }, [actorId]);

  return {
    auditLogs,
    auditOpen,
    auditSignal,
    setAuditOpen,
    showToast,
    toast,
    writeAuditLog,
  };
}
