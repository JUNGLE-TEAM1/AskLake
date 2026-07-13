import { Activity, LogIn, LogOut, RefreshCw } from "lucide-react";
import type { AuditEntry } from "../../types";
import type { CurrentUserResponse } from "../../types";

export function Topbar({
  auditLogs,
  auditOpen,
  currentUser,
  onAccount,
  onAuditToggle,
  onLogin,
  onLogout,
  onRefresh,
}: {
  auditLogs: AuditEntry[];
  auditOpen: boolean;
  currentUser: CurrentUserResponse | null;
  onAccount: () => void;
  onAuditToggle: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  const displayName = currentUser?.profile.displayName || currentUser?.displayName || "";
  const initials = currentUser?.profile.avatarInitials || displayName.slice(0, 2).toUpperCase();
  return (
    <header className="topbar">
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
        {currentUser ? (
          <>
            <button className="icon-button" type="button" aria-label="로그아웃" onClick={onLogout}>
              <LogOut size={18} />
            </button>
            <button className="avatar-button" type="button" aria-label="내 프로필" onClick={onAccount}>
              <span className="avatar">{initials}</span>
            </button>
          </>
        ) : (
          <button className="icon-button" type="button" aria-label="로그인" onClick={onLogin}>
            <LogIn size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
