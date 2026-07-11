import { Activity, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
      <TooltipProvider delayDuration={300}>
      <div className="topbar-actions">
        <div className="audit-menu">
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className={auditOpen ? "icon-button active" : "icon-button"} label="최근 API 호출" type="button" onClick={onAuditToggle}>
                <Activity />
                {auditLogs.length > 0 && <span className="audit-dot" />}
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>최근 API 호출</TooltipContent>
          </Tooltip>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton className="icon-button" label="새로고침" type="button" onClick={onRefresh}><RefreshCw /></IconButton>
          </TooltipTrigger>
          <TooltipContent>새로고침</TooltipContent>
        </Tooltip>
        <Avatar><AvatarFallback>AL</AvatarFallback></Avatar>
      </div>
      </TooltipProvider>
    </header>
  );
}
