import { Activity, RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { AuditEntry } from "../../types";

export function Topbar({
  auditLogs,
  auditOpen,
  onAuditToggle,
  onRefresh,
}: {
  auditLogs: AuditEntry[];
  auditOpen: boolean;
  onAuditToggle: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-actions">
        <div className="audit-menu">
          <IconButton className={auditOpen ? "icon-button active" : "icon-button"} label="최근 API 호출" type="button" onClick={onAuditToggle}>
            <Activity size={18} />
            {auditLogs.length > 0 && <span className="audit-dot" />}
          </IconButton>
          {auditOpen && (
            <section className="audit-popover">
              <div className="audit-popover-header">
                <strong>최근 API 호출</strong>
                <span>{auditLogs.length}건</span>
              </div>
              <div className="audit-log-list">
                {auditLogs.slice(0, 8).map((log) => (
                  <article className="audit-log-item" key={log.request_id}>
                    <div>
                      <strong>{log.action}</strong>
                      <span>{log.api_path}</span>
                    </div>
                    <em>{log.result}</em>
                  </article>
                ))}
                {auditLogs.length === 0 && <p>아직 기록된 호출이 없습니다.</p>}
              </div>
            </section>
          )}
        </div>
        <IconButton className="icon-button" label="새로고침" type="button" onClick={onRefresh}>
          <RefreshCw size={18} />
        </IconButton>
        <div className="avatar" />
      </div>
    </header>
  );
}
