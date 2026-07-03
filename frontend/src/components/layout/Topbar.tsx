import { Activity, RefreshCw, Search } from "lucide-react";
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
      <div className="search-box">
        <Search size={16} />
        <span>검색...</span>
      </div>
      <div className="topbar-actions">
        <div className="audit-menu">
          <button className={auditOpen ? "icon-button active" : "icon-button"} type="button" aria-label="최근 API 호출" onClick={onAuditToggle}>
            <Activity size={18} />
            {auditLogs.length > 0 && <span className="audit-dot" />}
          </button>
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
        <button className="icon-button" type="button" aria-label="Refresh" onClick={onRefresh}>
          <RefreshCw size={18} />
        </button>
        <div className="avatar" />
      </div>
    </header>
  );
}
