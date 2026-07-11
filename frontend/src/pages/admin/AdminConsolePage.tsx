import { Activity, AlertCircle, Boxes, Check, CircleUser, Plus, Save, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { InfoBox, PageTitle } from "../../components/common";
import {
  createAdminPermissionGrant,
  deleteAdminPermissionGrant,
  fetchAdminAuditLogs,
  fetchAdminGovernanceControls,
  fetchAdminGroups,
  fetchAdminPermissions,
  fetchAdminUsers,
  updateAdminPrincipalControl,
  updateAdminPermissionGrant,
  updateAdminResourceLock,
} from "../../services/adminApi";
import { ApiError } from "../../types";
import type {
  AdminAuditLogEntry,
  AdminAuditLogQuery,
  AdminGovernanceControlsResponse,
  AdminPermissionSummary,
  AdminPrincipalControl,
  AdminPrincipalControlType,
  AdminResourceLock,
  AdminResourceType,
  AdminUser,
  IdentityGroup,
  PermissionAction,
  PermissionGrant,
  PermissionPrincipalType,
} from "../../types";

type AdminTab = "users" | "groups" | "permissions" | "audit";

type AdminConsolePageProps = {
  onAction: (action: string, apiPath: string, targetId: string, result?: "success" | "failed", options?: { targetType?: "admin_module" }) => void;
  onNotify: (message: string, tone?: "success" | "info") => void;
};

const tabs: Array<{ id: AdminTab; label: string; icon: typeof CircleUser }> = [
  { id: "users", label: "사용자", icon: CircleUser },
  { id: "groups", label: "그룹", icon: Boxes },
  { id: "permissions", label: "권한", icon: ShieldCheck },
  { id: "audit", label: "감사 로그", icon: Activity },
];

const permissionOrder: PermissionAction[] = ["view", "query", "run", "manage", "delete", "share"];
const principalTypeOptions: PermissionPrincipalType[] = ["group", "user"];
const resourceTypeFilters: Array<"all" | AdminResourceType> = ["all", "dataset", "etl_job", "dashboard"];

type ActivitySubject =
  | { type: "user"; user: AdminUser }
  | { type: "group"; group: IdentityGroup };

export function AdminConsolePage({ onAction, onNotify }: AdminConsolePageProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<IdentityGroup[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionSummary[]>([]);
  const [principalControls, setPrincipalControls] = useState<AdminPrincipalControl[]>([]);
  const [resourceLocks, setResourceLocks] = useState<AdminResourceLock[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissionDraft, setPermissionDraft] = useState({
    actions: ["view"] as PermissionAction[],
    principalId: "analytics",
    principalType: "group" as PermissionPrincipalType,
    resourceKey: "",
  });
  const [permissionPending, setPermissionPending] = useState(false);
  const [controlPending, setControlPending] = useState<string | null>(null);
  const [deletingGrantId, setDeletingGrantId] = useState<string | null>(null);
  const [savingGrantId, setSavingGrantId] = useState<string | null>(null);
  const [auditQuery, setAuditQuery] = useState<AdminAuditLogQuery>({ limit: 100 });
  const [auditPending, setAuditPending] = useState(false);
  const [activitySubject, setActivitySubject] = useState<ActivitySubject | null>(null);
  const [activityLogs, setActivityLogs] = useState<AdminAuditLogEntry[]>([]);
  const [activityPending, setActivityPending] = useState(false);
  const onActionRef = useRef(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      fetchAdminUsers(),
      fetchAdminGroups(),
      fetchAdminPermissions(),
      fetchAdminGovernanceControls(),
      fetchAdminAuditLogs(),
    ])
      .then(([userResponse, groupResponse, permissionResponse, controlResponse, auditResponse]) => {
        if (!active) return;
        setUsers(userResponse.users);
        setGroups(groupResponse.groups);
        setPermissions(permissionResponse.resources);
        setPrincipalControls(controlResponse.principalControls);
        setResourceLocks(controlResponse.resourceLocks);
        setPermissionDraft((draft) => ({
          ...draft,
          resourceKey: draft.resourceKey || resourceKey(permissionResponse.resources[0]),
        }));
        setAuditLogs(auditResponse.logs);
        setError(null);
        onActionRef.current("admin.console.loaded", "/api/admin", "admin-console", "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        if (!active) return;
        const message = unknownError instanceof ApiError && unknownError.status === 403
          ? "관리자 권한이 필요합니다. admin 계정으로 로그인한 뒤 다시 시도해주세요."
          : unknownError instanceof ApiError ? unknownError.message : "관리 데이터를 불러오지 못했습니다.";
        setError(message);
        onActionRef.current("admin.console.load_failed", "/api/admin", "admin-console", "failed", { targetType: "admin_module" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const totalPermissionGrants = permissions.reduce((sum, resource) => sum + resource.grants.length, 0);
  const blockedPrincipalCount = principalControls.filter((control) => control.status === "blocked").length;
  const lockedResourceCount = resourceLocks.filter((lockItem) => lockItem.locked).length;

  const refreshAuditLogs = (query: AdminAuditLogQuery = auditQuery) => {
    setAuditPending(true);
    fetchAdminAuditLogs(query)
      .then((response) => {
        setAuditLogs(response.logs);
        setAuditQuery(query);
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "감사 로그를 불러오지 못했습니다.";
        onNotify(message, "info");
      })
      .finally(() => setAuditPending(false));
  };

  const refreshActivityLogs = () => {
    setActivityPending(true);
    return fetchAdminAuditLogs({ limit: 100 })
      .then((response) => setActivityLogs(response.logs))
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "최근 활동을 불러오지 못했습니다.";
        onNotify(message, "info");
      })
      .finally(() => setActivityPending(false));
  };

  const handleOpenActivity = (subject: ActivitySubject) => {
    setActivitySubject(subject);
    void refreshActivityLogs();
  };

  const applyControls = (response: AdminGovernanceControlsResponse) => {
    setPrincipalControls(response.principalControls);
    setResourceLocks(response.resourceLocks);
  };

  const handlePrincipalControlChange = (principalType: AdminPrincipalControlType, principalId: string, blocked: boolean, reason = "") => {
    const trimmedId = principalId.trim();
    if (!trimmedId) {
      onNotify("차단할 사용자 또는 그룹을 선택해주세요.", "info");
      return;
    }
    const pendingKey = `principal:${principalType}:${trimmedId}`;
    setControlPending(pendingKey);
    updateAdminPrincipalControl({
      principalId: trimmedId,
      principalType,
      reason: reason.trim() || undefined,
      status: blocked ? "blocked" : "active",
    })
      .then((response) => {
        applyControls(response);
        refreshAuditLogs();
        void refreshActivityLogs();
        onNotify(blocked ? "대상이 차단되었습니다." : "차단이 해제되었습니다.");
        onActionRef.current("admin.principal_control.updated", "/api/admin/governance/principals", trimmedId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "차단 상태를 변경하지 못했습니다.";
        onNotify(message, "info");
        onActionRef.current("admin.principal_control.update_failed", "/api/admin/governance/principals", trimmedId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setControlPending(null));
  };

  const handleResourceLockChange = (resource: AdminPermissionSummary, locked: boolean, reason = "") => {
    const pendingKey = `resource:${resource.resourceType}:${resource.resourceId}`;
    setControlPending(pendingKey);
    updateAdminResourceLock({
      locked,
      reason: reason.trim() || undefined,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
    })
      .then((response) => {
        applyControls(response);
        refreshAuditLogs();
        onNotify(locked ? "리소스가 잠겼습니다." : "리소스 잠금이 해제되었습니다.");
        onActionRef.current("admin.resource_lock.updated", "/api/admin/governance/resource-locks", resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "리소스 잠금 상태를 변경하지 못했습니다.";
        onNotify(message, "info");
        onActionRef.current("admin.resource_lock.update_failed", "/api/admin/governance/resource-locks", resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setControlPending(null));
  };

  const handlePermissionDraftActionChange = (action: PermissionAction, checked: boolean) => {
    setPermissionDraft((draft) => ({
      ...draft,
      actions: checked
        ? [...new Set([...draft.actions, action])]
        : draft.actions.filter((item) => item !== action),
    }));
  };

  const handleCreateGrant = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resource = permissions.find((item) => resourceKey(item) === permissionDraft.resourceKey);
    if (!resource) {
      onNotify("권한을 추가할 리소스를 선택해주세요.", "info");
      return;
    }
    if (permissionDraft.actions.length === 0) {
      onNotify("하나 이상의 권한을 선택해주세요.", "info");
      return;
    }
    if (permissionDraft.principalType !== "public" && !permissionDraft.principalId.trim()) {
      onNotify("권한을 부여할 대상을 선택해주세요.", "info");
      return;
    }

    setPermissionPending(true);
    createAdminPermissionGrant({
      actions: permissionDraft.actions,
      principalId: permissionDraft.principalType === "public" ? "public" : permissionDraft.principalId.trim(),
      principalType: permissionDraft.principalType,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
    })
      .then((response) => {
        setPermissions(response.resources);
        onNotify("권한이 추가되었습니다.");
        onActionRef.current("admin.permission_grant.created", "/api/admin/permissions", resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 추가하지 못했습니다.";
        onNotify(message, "info");
        onActionRef.current("admin.permission_grant.create_failed", "/api/admin/permissions", resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  const handleUpdateGrant = (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => {
    if (!grant.id) {
      onNotify("기본 권한은 직접 수정할 수 없습니다.", "info");
      return;
    }
    if (actions.length === 0) {
      onNotify("권한 항목에는 하나 이상의 권한이 필요합니다.", "info");
      return;
    }
    setSavingGrantId(grant.id);
    updateAdminPermissionGrant(grant.id, { actions })
      .then((response) => {
        setPermissions(response.resources);
        onNotify("권한이 수정되었습니다.");
        onActionRef.current("admin.permission_grant.updated", `/api/admin/permissions/${grant.id}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 수정하지 못했습니다.";
        onNotify(message, "info");
        onActionRef.current("admin.permission_grant.update_failed", `/api/admin/permissions/${grant.id}`, resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setSavingGrantId(null));
  };

  const handleDeleteGrant = (resource: AdminPermissionSummary, grant: PermissionGrant) => {
    if (!grant.id) {
      onNotify("기본 권한은 직접 삭제할 수 없습니다.", "info");
      return;
    }
    const grantId = grant.id;
    const previousPermissions = permissions;
    setDeletingGrantId(grantId);
    setPermissions((current) => removeGrantFromPermissions(current, grantId));
    deleteAdminPermissionGrant(grantId)
      .then((response) => {
        setPermissions(response.resources);
        onNotify("권한이 삭제되었습니다.");
        onActionRef.current("admin.permission_grant.deleted", `/api/admin/permissions/${grantId}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 삭제하지 못했습니다.";
        setPermissions(previousPermissions);
        onNotify(message, "info");
        onActionRef.current("admin.permission_grant.delete_failed", `/api/admin/permissions/${grantId}`, resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setDeletingGrantId(null));
  };

  return (
    <div className="content-grid module-page-grid admin-console-page">
      <div className="content-main">
        <PageTitle
          title="관리"
          description="사용자, 그룹, 리소스 권한, 감사 로그를 관리합니다."
          icon={<ShieldCheck size={28} />}
        />

        <div className="admin-console-metric-grid">
          <AdminMetric label="사용자" value={`${users.length}`} />
          <AdminMetric label="그룹" value={`${groups.length}`} />
          <AdminMetric label="권한 항목" value={`${totalPermissionGrants}`} />
          <AdminMetric label="제한 항목" value={`${blockedPrincipalCount + lockedResourceCount}`} />
        </div>

        <section className="asklake-review-card admin-console-panel">
          <div className="asklake-review-card-header">
            <span className="asklake-review-icon permission"><ShieldCheck size={17} /></span>
            <div>
              <h2>관리 콘솔</h2>
              <p>사용자, 그룹, 리소스 권한, 감사 로그를 관리합니다.</p>
            </div>
          </div>
          <div className="admin-console-tabs" role="tablist" aria-label="관리 콘솔">
            {tabs.map(({ id, icon: Icon, label }) => (
              <button
                aria-selected={activeTab === id}
                className={activeTab === id ? "active" : ""}
                key={id}
                role="tab"
                type="button"
                onClick={() => setActiveTab(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {loading && <InfoBox title="관리 데이터 로딩 중" body="관리 API에서 사용자, 그룹, 권한, 감사 로그를 가져오고 있습니다." />}
          {!loading && error && <InfoBox title={error.includes("관리자 권한") ? "관리자 권한 필요" : "관리 API 요청 실패"} body={error} />}
          {!loading && !error && (
            <>
              {activeTab === "users" && (
                <UsersTable
                  controlPending={controlPending}
                  principalControls={principalControls}
                  users={users}
                  onOpenActivity={(user) => handleOpenActivity({ type: "user", user })}
                  onPrincipalControlChange={handlePrincipalControlChange}
                />
              )}
              {activeTab === "groups" && (
                <GroupsTable
                  controlPending={controlPending}
                  groups={groups}
                  principalControls={principalControls}
                  onOpenActivity={(group) => handleOpenActivity({ type: "group", group })}
                  onPrincipalControlChange={handlePrincipalControlChange}
                />
              )}
              {activeTab === "permissions" && (
                <PermissionsTable
                  draft={permissionDraft}
                  deletingGrantId={deletingGrantId}
                  groups={groups}
                  pending={permissionPending}
                  permissions={permissions}
                  resourceLocks={resourceLocks}
                  savingGrantId={savingGrantId}
                  users={users}
                  onCreate={handleCreateGrant}
                  onDelete={handleDeleteGrant}
                  onDraftActionChange={handlePermissionDraftActionChange}
                  onDraftChange={setPermissionDraft}
                  onResourceLockChange={handleResourceLockChange}
                  onUpdate={handleUpdateGrant}
                />
              )}
              {activeTab === "audit" && <AuditLogTable logs={auditLogs} pending={auditPending} query={auditQuery} onQueryChange={refreshAuditLogs} />}
            </>
          )}
        </section>
      </div>
      {activitySubject && (
        <ActivityModal
          activityLogs={activityLogs}
          controlPending={controlPending}
          loading={activityPending}
          principalControls={principalControls}
          subject={activitySubject}
          onClose={() => setActivitySubject(null)}
          onPrincipalControlChange={handlePrincipalControlChange}
        />
      )}
    </div>
  );
}

function AdminMetric({ label, value }: { label: string; value: string }) {
  return (
    <article className="admin-console-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function UsersTable({
  controlPending,
  principalControls,
  users,
  onOpenActivity,
  onPrincipalControlChange,
}: {
  controlPending: string | null;
  principalControls: AdminPrincipalControl[];
  users: AdminUser[];
  onOpenActivity: (user: AdminUser) => void;
  onPrincipalControlChange: (principalType: AdminPrincipalControlType, principalId: string, blocked: boolean, reason?: string) => void;
}) {
  return (
    <div className="admin-console-table-scroll">
      <table className="schema-table admin-console-table">
        <thead>
          <tr>
            <th>사용자</th>
            <th>Role</th>
            <th>그룹</th>
            <th>권한 요약</th>
            <th>상태</th>
            <th>관리</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const control = principalControls.find((item) => item.principalType === "user" && item.principalId === user.id);
            const blocked = control?.status === "blocked";
            const pendingKey = `principal:user:${user.id}`;
            const isAdmin = user.role.toLowerCase() === "admin";
            return (
              <tr key={user.id}>
                <td>
                  <strong>{user.displayName}</strong>
                  <span>{user.email}</span>
                  {blocked && control?.reason && <em className="admin-internal-note">내부 사유: {control.reason}</em>}
                  {blocked && control?.updatedAt && <em className="admin-internal-note">변경: {control.updatedBy || "-"} · {formatTime(control.updatedAt)}</em>}
                </td>
                <td><AdminChip>{user.role}</AdminChip></td>
                <td>{user.groups.map((group) => group.name).join(", ") || "-"}</td>
                <td>{user.permissionsSummary.canView} view · {user.permissionsSummary.canManage} manage</td>
                <td><AdminChip tone={blocked ? "danger" : "default"}>{blocked ? "차단됨" : user.status}</AdminChip></td>
                <td className="admin-console-row-actions">
                  <button className="admin-row-action-button" type="button" onClick={() => onOpenActivity(user)}>
                    <Activity size={15} />
                    <span>활동</span>
                  </button>
                  {isAdmin ? (
                    <span className="admin-console-readonly-badge">운영자</span>
                  ) : (
                    <button
                      className={blocked ? "admin-row-action-button restore" : "admin-row-action-button danger"}
                      type="button"
                      disabled={controlPending === pendingKey}
                      onClick={() => onPrincipalControlChange("user", user.id, !blocked, blocked ? "관리자 차단 해제" : "관리자 차단")}
                    >
                      {blocked ? <Check size={15} /> : <AlertCircle size={15} />}
                      <span>{blocked ? "차단 해제" : "차단"}</span>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupsTable({
  controlPending,
  groups,
  principalControls,
  onOpenActivity,
  onPrincipalControlChange,
}: {
  controlPending: string | null;
  groups: IdentityGroup[];
  principalControls: AdminPrincipalControl[];
  onOpenActivity: (group: IdentityGroup) => void;
  onPrincipalControlChange: (principalType: AdminPrincipalControlType, principalId: string, blocked: boolean, reason?: string) => void;
}) {
  return (
    <div className="admin-console-table-scroll">
      <table className="schema-table admin-console-table">
        <thead>
          <tr>
            <th>그룹</th>
            <th>설명</th>
            <th>멤버</th>
            <th>상태</th>
            <th>관리</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const control = principalControls.find((item) => item.principalType === "group" && item.principalId === group.id);
            const blocked = control?.status === "blocked";
            const pendingKey = `principal:group:${group.id}`;
            return (
              <tr key={group.id}>
                <td>
                  <strong>{group.name}</strong>
                  {blocked && control?.reason && <em className="admin-internal-note">내부 사유: {control.reason}</em>}
                  {blocked && control?.updatedAt && <em className="admin-internal-note">변경: {control.updatedBy || "-"} · {formatTime(control.updatedAt)}</em>}
                </td>
                <td>{group.description || "-"}</td>
                <td>{typeof group.memberCount === "number" ? `${group.memberCount}명` : "-"}</td>
                <td><AdminChip tone={blocked ? "danger" : "default"}>{blocked ? "차단됨" : "정상"}</AdminChip></td>
                <td className="admin-console-row-actions">
                  <button className="admin-row-action-button" type="button" onClick={() => onOpenActivity(group)}>
                    <Activity size={15} />
                    <span>활동</span>
                  </button>
                  <button
                    className={blocked ? "admin-row-action-button restore" : "admin-row-action-button danger"}
                    type="button"
                    disabled={controlPending === pendingKey}
                    onClick={() => onPrincipalControlChange("group", group.id, !blocked, blocked ? "관리자 차단 해제" : "관리자 차단")}
                  >
                    {blocked ? <Check size={15} /> : <AlertCircle size={15} />}
                    <span>{blocked ? "차단 해제" : "차단"}</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityModal({
  activityLogs,
  controlPending,
  loading,
  principalControls,
  subject,
  onClose,
  onPrincipalControlChange,
}: {
  activityLogs: AdminAuditLogEntry[];
  controlPending: string | null;
  loading: boolean;
  principalControls: AdminPrincipalControl[];
  subject: ActivitySubject;
  onClose: () => void;
  onPrincipalControlChange: (principalType: AdminPrincipalControlType, principalId: string, blocked: boolean, reason?: string) => void;
}) {
  const isUser = subject.type === "user";
  const principalType: AdminPrincipalControlType = isUser ? "user" : "group";
  const principalId = isUser ? subject.user.id : subject.group.id;
  const control = principalControls.find((item) => item.principalType === principalType && item.principalId === principalId);
  const blocked = control?.status === "blocked";
  const isAdmin = isUser && subject.user.role.toLowerCase() === "admin";
  const pendingKey = `principal:${principalType}:${principalId}`;
  const logs = filterActivityLogs(activityLogs, subject).slice(0, 10);
  const summary = isUser
    ? [subject.user.email, subject.user.role, subject.user.groups.map((group) => group.name).join(", ") || "소속 그룹 없음"]
    : [subject.group.description || "설명 없음", `${subject.group.memberCount ?? 0}명`];

  return (
    <div className="admin-activity-modal" role="dialog" aria-modal="true" aria-label={`${isUser ? subject.user.displayName : subject.group.name} 활동`} onClick={onClose}>
      <section onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{isUser ? "사용자 활동" : "그룹 활동"}</span>
            <h2>{isUser ? subject.user.displayName : subject.group.name}</h2>
            <p>{summary.join(" · ")}</p>
          </div>
          <button className="icon-button" type="button" aria-label="닫기" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="admin-activity-modal-status">
          <AdminChip tone={blocked ? "danger" : "default"}>{blocked ? "차단됨" : "정상"}</AdminChip>
          {isAdmin ? (
            <span className="admin-console-readonly-badge">운영자</span>
          ) : (
            <button
              className={blocked ? "admin-row-action-button restore" : "admin-row-action-button danger"}
              type="button"
              disabled={controlPending === pendingKey}
              onClick={() => onPrincipalControlChange(principalType, principalId, !blocked, blocked ? "관리자 차단 해제" : "관리자 차단")}
            >
              {blocked ? <Check size={15} /> : <AlertCircle size={15} />}
              <span>{blocked ? "차단 해제" : "차단"}</span>
            </button>
          )}
        </div>

        <div className="admin-activity-log-heading">
          <h3>최근 활동</h3>
          {loading && <span>불러오는 중</span>}
        </div>
        <div className="admin-activity-log-list">
          {!loading && logs.length === 0 && <p className="admin-activity-empty">최근 활동이 없습니다.</p>}
          {logs.map((log) => (
            <article className="admin-activity-log-row" key={log.requestId}>
              <div>
                <strong>{log.action}</strong>
                <span>{log.targetName || log.targetId} · {log.targetType}</span>
              </div>
              <div>
                <AdminChip tone={log.result === "forbidden" ? "danger" : log.result === "failed" ? "warning" : "default"}>{auditResultLabel(log.result)}</AdminChip>
                <time>{formatTime(log.createdAt)}</time>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function filterActivityLogs(logs: AdminAuditLogEntry[], subject: ActivitySubject) {
  if (subject.type === "group") {
    return [...logs]
      .filter((log) => log.actorGroups.includes(subject.group.id))
      .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
  }

  const identifiers = new Set([
    subject.user.id,
    subject.user.displayName,
    subject.user.email,
  ].map((value) => value.trim().toLowerCase()).filter(Boolean));

  return [...logs]
    .filter((log) => [
      log.actorId,
      log.actorName,
      typeof log.metadata?.actorEmail === "string" ? log.metadata.actorEmail : "",
      typeof log.metadata?.email === "string" ? log.metadata.email : "",
    ].some((value) => identifiers.has((value ?? "").trim().toLowerCase())))
    .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
}

type PermissionDraft = {
  actions: PermissionAction[];
  principalId: string;
  principalType: PermissionPrincipalType;
  resourceKey: string;
};

function PermissionsTable({
  draft,
  deletingGrantId,
  groups,
  pending,
  permissions,
  resourceLocks,
  savingGrantId,
  users,
  onCreate,
  onDelete,
  onDraftActionChange,
  onDraftChange,
  onResourceLockChange,
  onUpdate,
}: {
  draft: PermissionDraft;
  deletingGrantId: string | null;
  groups: IdentityGroup[];
  pending: boolean;
  permissions: AdminPermissionSummary[];
  resourceLocks: AdminResourceLock[];
  savingGrantId: string | null;
  users: AdminUser[];
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onDelete: (resource: AdminPermissionSummary, grant: PermissionGrant) => void;
  onDraftActionChange: (action: PermissionAction, checked: boolean) => void;
  onDraftChange: React.Dispatch<React.SetStateAction<PermissionDraft>>;
  onResourceLockChange: (resource: AdminPermissionSummary, locked: boolean, reason?: string) => void;
  onUpdate: (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => void;
}) {
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState<"all" | AdminResourceType>("all");
  const principalOptions = groups.map((group) => ({ label: group.name, value: group.id }));
  const hasPrincipalOptions = draft.principalType === "user" || principalOptions.length > 0;
  const normalizedPrincipalInput = draft.principalId.trim().toLowerCase();
  const isAdminUserPrincipalInput = draft.principalType === "user" && users.some((user) => (
    user.role.toLowerCase() === "admin"
    && [user.displayName, user.email, user.id].some((value) => value.toLowerCase() === normalizedPrincipalInput)
  ));
  const canCreateGrant = hasPrincipalOptions
    && (draft.principalType !== "user" || Boolean(draft.principalId.trim()))
    && !isAdminUserPrincipalInput;
  const normalizedSearch = resourceSearch.trim().toLowerCase();
  const filteredResources = permissions.filter((resource) => {
    const matchesType = resourceTypeFilter === "all" || resource.resourceType === resourceTypeFilter;
    const searchTarget = `${resource.resourceName} ${resource.resourceId} ${resource.owner ?? ""} ${resource.createdBy ?? ""}`.toLowerCase();
    return matchesType && (!normalizedSearch || searchTarget.includes(normalizedSearch));
  });
  const selectedResource = filteredResources.find((resource) => resourceKey(resource) === draft.resourceKey)
    ?? filteredResources[0]
    ?? permissions.find((resource) => resourceKey(resource) === draft.resourceKey);
  const selectedResourceLock = selectedResource
    ? resourceLocks.find((lockItem) => lockKey(lockItem) === resourceKey(selectedResource))
    : undefined;

  const selectResource = (resource: AdminPermissionSummary) => {
    onDraftChange((current) => ({ ...current, resourceKey: resourceKey(resource) }));
  };

  useEffect(() => {
    if (!principalTypeOptions.includes(draft.principalType)) {
      onDraftChange((current) => ({
        ...current,
        principalId: groups[0]?.id || "",
        principalType: "group",
      }));
      return;
    }
    if (draft.principalType === "user") return;
    const hasCurrentPrincipal = principalOptions.some((option) => option.value === draft.principalId);
    if (hasCurrentPrincipal) return;
    const nextPrincipalId = principalOptions[0]?.value || "";
    if (draft.principalId === nextPrincipalId) return;
    onDraftChange((current) => ({
      ...current,
      principalId: nextPrincipalId,
    }));
  }, [draft.principalId, draft.principalType, groups, onDraftChange, principalOptions]);

  return (
    <div className="admin-permission-editor">
      <div className="admin-permission-toolbar">
        <div className="admin-permission-filter-tabs" aria-label="리소스 유형 필터">
          {resourceTypeFilters.map((type) => (
            <button
              className={resourceTypeFilter === type ? "active" : ""}
              key={type}
              type="button"
              onClick={() => setResourceTypeFilter(type)}
            >
              {type === "all" ? "전체" : resourceTypeLabel(type)}
            </button>
          ))}
        </div>
        <label className="admin-permission-search">
          <span>리소스 검색</span>
          <input
            placeholder="이름, ID, 소유자 검색"
            value={resourceSearch}
            onChange={(event) => setResourceSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="admin-permission-workbench">
        <div className="admin-permission-resource-list" aria-label="권한 리소스 목록">
          {filteredResources.slice(0, 80).map((resource) => (
            <button
              className={resourceKey(resource) === resourceKey(selectedResource) ? "admin-permission-resource-row active" : "admin-permission-resource-row"}
              key={`${resource.resourceType}-${resource.resourceId}`}
              type="button"
              onClick={() => selectResource(resource)}
            >
              <div>
                <span className="admin-resource-type-badge">{resourceTypeLabel(resource.resourceType)}</span>
                <strong title={resource.resourceId}>{resource.resourceName}</strong>
              </div>
              <em>권한 {resource.grants.length}개</em>
            </button>
          ))}
          {filteredResources.length === 0 && <span className="admin-console-muted">조건에 맞는 리소스가 없습니다.</span>}
        </div>

        <section className="admin-permission-detail" aria-label="선택 리소스 권한 상세">
          {selectedResource ? (
            <>
              <header>
                <div>
                  <h3 title={selectedResource.resourceId}>{selectedResource.resourceName}</h3>
                  <p>{resourceTypeLabel(selectedResource.resourceType)} · 소유자 {selectedResource.owner || selectedResource.createdBy || "-"} · 권한 {selectedResource.grants.length}개</p>
                </div>
                <div className="admin-resource-state-actions">
                  <div className="admin-console-chip-row">
                    {selectedResourceLock?.locked && <AdminChip tone="warning">잠김</AdminChip>}
                    {permissionOrder.filter((action) => canAction(selectedResource, action)).map((action) => (
                      <AdminChip key={`${selectedResource.resourceId}-${action}`}>{actionLabel(action)}</AdminChip>
                    ))}
                  </div>
                  <button
                    className={selectedResourceLock?.locked ? "secondary-button admin-lock-button" : "secondary-button admin-lock-button"}
                    type="button"
                    onClick={() => onResourceLockChange(selectedResource, !selectedResourceLock?.locked, selectedResourceLock?.locked ? "관리자 잠금 해제" : "관리자 잠금")}
                  >
                    {selectedResourceLock?.locked ? <Check size={15} /> : <ShieldCheck size={15} />}
                    <span>{selectedResourceLock?.locked ? "잠금 해제" : "리소스 잠금"}</span>
                  </button>
                </div>
              </header>

              <form className="admin-permission-form compact" onSubmit={onCreate}>
                <div className="admin-permission-form-title">
                  <strong>권한 추가</strong>
                </div>
                <label className="field">
                  <span>대상 유형</span>
                  <select value={draft.principalType} onChange={(event) => {
                    const nextType = event.target.value as PermissionPrincipalType;
                    const nextPrincipalId = nextType === "group" ? groups[0]?.id || "" : "";
                    onDraftChange((current) => ({
                      ...current,
                      principalId: nextPrincipalId,
                      principalType: nextType,
                      resourceKey: resourceKey(selectedResource),
                    }));
                  }}>
                    {principalTypeOptions.map((type) => <option key={type} value={type}>{principalTypeLabel(type)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>대상</span>
                  {draft.principalType === "user" ? (
                    <>
                      <input
                        placeholder="사용자 ID 입력"
                        value={draft.principalId}
                        onChange={(event) => onDraftChange((current) => ({ ...current, principalId: event.target.value, resourceKey: resourceKey(selectedResource) }))}
                      />
                      {isAdminUserPrincipalInput && <small className="admin-permission-field-hint danger">운영자 계정에는 개별 권한을 추가할 수 없습니다.</small>}
                    </>
                  ) : hasPrincipalOptions ? (
                    <select
                      value={draft.principalId}
                      onChange={(event) => onDraftChange((current) => ({ ...current, principalId: event.target.value, resourceKey: resourceKey(selectedResource) }))}
                    >
                      {principalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  ) : (
                    <span className="admin-permission-empty-target">권한을 부여할 그룹이 없습니다.</span>
                  )}
                </label>
                <div className="admin-permission-action-group">
                  <span>권한</span>
                  <div className="admin-permission-actions" aria-label="추가할 권한">
                    {permissionOrder.map((action) => (
                      <label key={action}>
                        <input
                          checked={draft.actions.includes(action)}
                          type="checkbox"
                          onChange={(event) => onDraftActionChange(action, event.target.checked)}
                        />
                        <span>{actionLabel(action)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <button className="primary-button admin-grant-create-button" type="submit" disabled={pending || permissions.length === 0 || !canCreateGrant} onClick={() => selectResource(selectedResource)}>
                  <Plus size={16} />
                  <span>권한 추가</span>
                </button>
              </form>

              <div className="admin-grant-list">
                {selectedResource.grants.map((grant, index) => (
                  <GrantEditor
                    grant={grant}
                    key={`${selectedResource.resourceId}-${grant.id ?? grant.principalType}-${grant.principalId}-${index}`}
                    pending={pending || savingGrantId === grant.id || deletingGrantId === grant.id}
                    resource={selectedResource}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                  />
                ))}
                {selectedResource.grants.length === 0 && <span className="admin-console-muted">등록된 권한이 없습니다.</span>}
              </div>
            </>
          ) : (
            <InfoBox title="선택된 리소스 없음" body="권한을 관리할 리소스를 선택해주세요." />
          )}
        </section>
      </div>
    </div>
  );
}

function GrantEditor({
  grant,
  pending,
  resource,
  onDelete,
  onUpdate,
}: {
  grant: PermissionGrant;
  pending: boolean;
  resource: AdminPermissionSummary;
  onDelete: (resource: AdminPermissionSummary, grant: PermissionGrant) => void;
  onUpdate: (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => void;
}) {
  const editable = Boolean(grant.id);
  const [draftActions, setDraftActions] = useState<PermissionAction[]>(grant.actions);

  useEffect(() => {
    setDraftActions(grant.actions);
  }, [grant.actions]);

  const toggleAction = (action: PermissionAction, checked: boolean) => {
    const nextActions = checked
      ? [...new Set([...draftActions, action])]
      : draftActions.filter((item) => item !== action);
    setDraftActions(nextActions);
  };

  return (
    <article className={editable ? "admin-grant-item" : "admin-grant-item readonly"}>
      <div>
        <strong>{principalTypeLabel(grant.principalType)} · {grant.principalId}</strong>
        <span>{grant.source === "owner" ? "소유자 권한" : grant.source === "admin" ? "관리자 설정" : "기본 권한"}</span>
      </div>
      <div className="admin-grant-actions" aria-label={`${grant.principalId} 권한`}>
        {permissionOrder.map((action) => (
          <label key={action}>
            <input
              checked={draftActions.includes(action)}
              disabled={!editable || pending}
              type="checkbox"
              onChange={(event) => toggleAction(action, event.target.checked)}
            />
            <span>{actionLabel(action)}</span>
          </label>
        ))}
      </div>
      <div className="admin-grant-tools">
        {editable ? (
          <>
            <button className="icon-button" type="button" aria-label="권한 저장" disabled={pending} onClick={() => onUpdate(resource, grant, draftActions)}>
              <Save size={16} />
            </button>
            <button className="icon-button danger" type="button" aria-label="권한 삭제" disabled={pending} onClick={() => onDelete(resource, grant)}>
              <Trash2 size={16} />
            </button>
          </>
        ) : (
          <span className="admin-console-readonly-badge">읽기 전용</span>
        )}
      </div>
    </article>
  );
}

function AuditLogTable({
  logs,
  onQueryChange,
  pending,
  query,
}: {
  logs: AdminAuditLogEntry[];
  onQueryChange: (query: AdminAuditLogQuery) => void;
  pending: boolean;
  query: AdminAuditLogQuery;
}) {
  const [draft, setDraft] = useState({
    limit: String(query.limit ?? 100),
    q: query.q ?? "",
    resourceType: query.resourceType ?? "",
    result: query.result ?? "",
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onQueryChange({
      limit: Number(draft.limit) || 100,
      q: draft.q.trim() || undefined,
      resourceType: draft.resourceType || undefined,
      result: draft.result ? draft.result as AdminAuditLogQuery["result"] : undefined,
    });
  };

  return (
    <div className="admin-audit-panel">
      <form className="admin-audit-filter" onSubmit={submit}>
        <label>
          <span>검색</span>
          <input placeholder="actor, action, resource ID" value={draft.q} onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))} />
        </label>
        <label>
          <span>대상</span>
          <select value={draft.resourceType} onChange={(event) => setDraft((current) => ({ ...current, resourceType: event.target.value }))}>
            <option value="">전체</option>
            <option value="dataset">Dataset</option>
            <option value="etl_job">Job</option>
            <option value="dashboard">Dashboard</option>
            <option value="auth">Auth</option>
            <option value="user">User</option>
            <option value="group">Group</option>
            <option value="admin_module">Admin</option>
          </select>
        </label>
        <label>
          <span>결과</span>
          <select value={draft.result} onChange={(event) => setDraft((current) => ({ ...current, result: event.target.value }))}>
            <option value="">전체</option>
            <option value="success">성공</option>
            <option value="failed">실패</option>
            <option value="forbidden">차단</option>
          </select>
        </label>
        <label>
          <span>개수</span>
          <input inputMode="numeric" value={draft.limit} onChange={(event) => setDraft((current) => ({ ...current, limit: event.target.value }))} />
        </label>
        <button className="primary-button admin-audit-search-button" type="submit" disabled={pending}>
          <Search size={15} />
          <span>조회</span>
        </button>
      </form>
      <div className="admin-console-table-scroll">
        <table className="schema-table admin-console-table">
          <thead>
            <tr>
              <th>활동</th>
              <th>사용자</th>
              <th>대상</th>
              <th>결과</th>
              <th>시간</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.requestId}>
                <td><strong>{log.action}</strong><span>{log.httpMethod ? `${log.httpMethod} ` : ""}{log.apiPath}</span></td>
                <td><strong>{log.actorName || log.actorId}</strong><span>{log.actorRole || log.actorId}</span></td>
                <td><strong>{log.targetName || log.targetId}</strong><span>{log.targetType}:{log.targetId}</span></td>
                <td><AdminChip tone={log.result === "forbidden" ? "danger" : log.result === "failed" ? "warning" : "default"}>{log.result}</AdminChip></td>
                <td>{formatTime(log.createdAt)}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5}><span className="admin-console-muted">조건에 맞는 감사 로그가 없습니다.</span></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminChip({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "danger" | "warning" }) {
  return <span className={`admin-console-chip ${tone}`}>{children}</span>;
}

function auditResultLabel(result: AdminAuditLogEntry["result"]) {
  if (result === "forbidden") return "차단";
  if (result === "failed") return "실패";
  return "성공";
}

function resourceKey(resource?: AdminPermissionSummary) {
  return resource ? `${resource.resourceType}:${resource.resourceId}` : "";
}

function lockKey(lockItem: AdminResourceLock) {
  return `${lockItem.resourceType}:${lockItem.resourceId}`;
}

function resourceTypeLabel(type: AdminResourceType) {
  if (type === "dataset") return "Dataset";
  if (type === "etl_job") return "Job";
  return "Dashboard";
}

function principalTypeLabel(type: PermissionPrincipalType) {
  if (type === "group") return "그룹";
  if (type === "user") return "사용자";
  if (type === "role") return "역할";
  return "공개";
}

function actionLabel(action: PermissionAction) {
  if (action === "view") return "조회";
  if (action === "query") return "쿼리";
  if (action === "run") return "실행";
  if (action === "manage") return "관리";
  if (action === "delete") return "삭제";
  return "공유";
}

function canAction(resource: AdminPermissionSummary, action: PermissionAction) {
  const permissions = resource.currentActorPermissions;
  if (!permissions) return false;
  if (action === "view") return permissions.canView;
  if (action === "query") return permissions.canQuery;
  if (action === "run") return permissions.canRun;
  if (action === "manage") return permissions.canManage;
  if (action === "delete") return permissions.canDelete;
  return permissions.canShare;
}

function removeGrantFromPermissions(resources: AdminPermissionSummary[], grantId: string) {
  return resources.map((resource) => ({
    ...resource,
    grants: resource.grants.filter((grant) => grant.id !== grantId),
  }));
}

function formatTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}
