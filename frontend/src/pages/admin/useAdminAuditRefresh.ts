import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { fetchAdminAuditLogs } from "../../services/adminApi";
import type { AdminAuditLogEntry, AdminAuditLogQuery } from "../../types";
import {
  adminConsoleLoadFailure,
  createLatestAdminAuditRequestTracker,
} from "./adminConsoleLoadState";
import type {
  AdminConsoleLoadFailure,
  AdminConsoleLoadSection,
} from "./adminConsoleLoadState";

type UseAdminAuditRefreshOptions = {
  onNotify: (message: string, tone?: "success" | "info") => void;
  setAuditLogs: Dispatch<SetStateAction<AdminAuditLogEntry[]>>;
  setLoadErrors: Dispatch<SetStateAction<Partial<Record<AdminConsoleLoadSection, AdminConsoleLoadFailure>>>>;
};

export function useAdminAuditRefresh({ onNotify, setAuditLogs, setLoadErrors }: UseAdminAuditRefreshOptions) {
  const [auditQuery, setAuditQuery] = useState<AdminAuditLogQuery>({ limit: 100 });
  const [auditPending, setAuditPending] = useState(false);
  const [auditRefreshFailure, setAuditRefreshFailure] = useState<AdminConsoleLoadFailure | null>(null);
  const trackerRef: MutableRefObject<ReturnType<typeof createLatestAdminAuditRequestTracker>> = useRef(
    createLatestAdminAuditRequestTracker(),
  );

  useEffect(() => () => trackerRef.current.invalidate(), []);

  const refreshAuditLogs = useCallback((query?: AdminAuditLogQuery) => {
    const nextQuery = query ?? auditQuery;
    const requestId = trackerRef.current.begin();
    setAuditPending(true);
    void fetchAdminAuditLogs(nextQuery)
      .then((response) => {
        if (!trackerRef.current.isLatest(requestId)) return;
        setAuditLogs(response.logs);
        setAuditQuery(nextQuery);
        setAuditRefreshFailure(null);
        setLoadErrors((current) => {
          if (!current.audit) return current;
          const next = { ...current };
          delete next.audit;
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!trackerRef.current.isLatest(requestId)) return;
        const failure = adminConsoleLoadFailure(error, "감사 로그를 불러오지 못했습니다.");
        setAuditRefreshFailure(failure);
        onNotify(failure.message, "info");
      })
      .finally(() => {
        if (trackerRef.current.isLatest(requestId)) setAuditPending(false);
      });
  }, [auditQuery, onNotify, setAuditLogs, setLoadErrors]);

  return { auditPending, auditQuery, auditRefreshFailure, refreshAuditLogs };
}
