import { useEffect, useState } from "react";
import type { AuditEntry, AuditResult, AuditTargetType } from "../types";

type AuditLogOptions = {
  targetType?: AuditTargetType;
};

export type ToastState = {
  message: string;
  tone: "success" | "info";
};

export function useAuditLogs() {
  const [auditSignal, setAuditSignal] = useState("idle");
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const showToast = (message: string, tone: ToastState["tone"] = "success") => {
    setToast({ message, tone });
  };

  const writeAuditLog = (action: string, apiPath: string, targetId: string, result: AuditResult = "success", options: AuditLogOptions = {}) => {
    const entry: AuditEntry = {
      action,
      actor_id: "demo.user@asklake.local",
      api_path: apiPath,
      created_at: new Date().toISOString(),
      request_id: `req_${Date.now()}`,
      result,
      target_id: targetId,
      target_type: options.targetType ?? "etl_job",
    };

    setAuditSignal(action);
    setAuditLogs((logs) => [entry, ...logs].slice(0, 50));
    setToast({ message: `${action} 호출 완료`, tone: result === "success" ? "success" : "info" });

    const debugWindow = window as typeof window & { __asklakeAuditLogs?: AuditEntry[]; __asklakeLastAction?: AuditEntry };
    debugWindow.__asklakeAuditLogs = [entry, ...(debugWindow.__asklakeAuditLogs ?? [])].slice(0, 50);
    debugWindow.__asklakeLastAction = entry;

    try {
      const previous = JSON.parse(window.localStorage.getItem("asklake.auditLogs") ?? "[]");
      window.localStorage.setItem("asklake.auditLogs", JSON.stringify([entry, ...previous].slice(0, 50)));
    } catch {
      console.warn("[AskLake mock API] local audit storage is unavailable in this browser context.");
    }

    console.info("[AskLake mock API]", entry);
  };

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

