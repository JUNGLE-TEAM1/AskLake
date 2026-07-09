import { Activity, Boxes, CircleUser, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { InfoBox, PageTitle } from "../../components/common";
import {
  createAdminPermissionGrant,
  deleteAdminPermissionGrant,
  fetchAdminAuditLogs,
  fetchAdminGroups,
  fetchAdminPermissions,
  fetchAdminUsers,
  updateAdminPermissionGrant,
} from "../../services/adminApi";
import { ApiError } from "../../types";
import type {
  AdminAuditLogEntry,
  AdminPermissionSummary,
  AdminUser,
  IdentityGroup,
  PermissionAction,
  PermissionGrant,
  PermissionPrincipalType,
} from "../../types";

type AdminTab = "users" | "groups" | "permissions" | "audit";

type AdminConsolePageProps = {
  onAction: (action: string, apiPath: string, targetId: string, result?: "success" | "failed", options?: { targetType?: "admin_module" }) => void;
};

const tabs: Array<{ id: AdminTab; label: string; icon: typeof CircleUser }> = [
  { id: "users", label: "사용자", icon: CircleUser },
  { id: "groups", label: "그룹", icon: Boxes },
  { id: "permissions", label: "권한", icon: ShieldCheck },
  { id: "audit", label: "감사 로그", icon: Activity },
];

const permissionOrder: PermissionAction[] = ["view", "query", "run", "manage", "delete", "share"];
const principalTypeOptions: PermissionPrincipalType[] = ["group", "user", "role", "public"];

export function AdminConsolePage({ onAction }: AdminConsolePageProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<IdentityGroup[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionSummary[]>([]);
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
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
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
      fetchAdminAuditLogs(),
    ])
      .then(([userResponse, groupResponse, permissionResponse, auditResponse]) => {
        if (!active) return;
        setUsers(userResponse.users);
        setGroups(groupResponse.groups);
        setPermissions(permissionResponse.resources);
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
      setPermissionMessage("권한을 추가할 리소스를 선택해주세요.");
      return;
    }
    if (permissionDraft.actions.length === 0) {
      setPermissionMessage("하나 이상의 action을 선택해주세요.");
      return;
    }
    if (permissionDraft.principalType !== "public" && !permissionDraft.principalId.trim()) {
      setPermissionMessage("principal ID를 입력해주세요.");
      return;
    }

    setPermissionPending(true);
    setPermissionMessage(null);
    createAdminPermissionGrant({
      actions: permissionDraft.actions,
      principalId: permissionDraft.principalType === "public" ? "public" : permissionDraft.principalId.trim(),
      principalType: permissionDraft.principalType,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
    })
      .then((response) => {
        setPermissions(response.resources);
        setPermissionMessage("권한 grant가 추가되었습니다.");
        onActionRef.current("admin.permission_grant.created", "/api/admin/permissions", resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한 grant를 추가하지 못했습니다.";
        setPermissionMessage(message);
        onActionRef.current("admin.permission_grant.create_failed", "/api/admin/permissions", resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  const handleUpdateGrant = (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => {
    if (!grant.id) {
      setPermissionMessage("payload grant는 아직 직접 수정할 수 없습니다. admin API로 생성된 grant만 수정 가능합니다.");
      return;
    }
    if (actions.length === 0) {
      setPermissionMessage("grant에는 하나 이상의 action이 필요합니다.");
      return;
    }
    setPermissionPending(true);
    setPermissionMessage(null);
    updateAdminPermissionGrant(grant.id, { actions })
      .then((response) => {
        setPermissions(response.resources);
        setPermissionMessage("권한 grant가 수정되었습니다.");
        onActionRef.current("admin.permission_grant.updated", `/api/admin/permissions/${grant.id}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한 grant를 수정하지 못했습니다.";
        setPermissionMessage(message);
        onActionRef.current("admin.permission_grant.update_failed", `/api/admin/permissions/${grant.id}`, resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  const handleDeleteGrant = (resource: AdminPermissionSummary, grant: PermissionGrant) => {
    if (!grant.id) {
      setPermissionMessage("payload grant는 아직 직접 삭제할 수 없습니다. admin API로 생성된 grant만 삭제 가능합니다.");
      return;
    }
    setPermissionPending(true);
    setPermissionMessage(null);
    deleteAdminPermissionGrant(grant.id)
      .then((response) => {
        setPermissions(response.resources);
        setPermissionMessage("권한 grant가 삭제되었습니다.");
        onActionRef.current("admin.permission_grant.deleted", `/api/admin/permissions/${grant.id}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한 grant를 삭제하지 못했습니다.";
        setPermissionMessage(message);
        onActionRef.current("admin.permission_grant.delete_failed", `/api/admin/permissions/${grant.id}`, resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  return (
    <div className="content-grid module-page-grid admin-console-page">
      <div className="content-main">
        <PageTitle
          title="관리"
          description="사용자, 그룹, 리소스 권한, 감사 로그를 한 화면에서 확인합니다."
          icon={<ShieldCheck size={28} />}
        />

        <div className="admin-console-metric-grid">
          <AdminMetric label="사용자" value={`${users.length}`} />
          <AdminMetric label="그룹" value={`${groups.length}`} />
          <AdminMetric label="권한 Grant" value={`${totalPermissionGrants}`} />
          <AdminMetric label="감사 로그" value={`${auditLogs.length}`} />
        </div>

        <section className="xflow-review-card admin-console-panel">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon permission"><ShieldCheck size={17} /></span>
            <div>
              <h2>Governance Console</h2>
              <p>사용자, 그룹, 리소스 grant, 감사 로그를 조회합니다.</p>
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
              {activeTab === "users" && <UsersTable users={users} />}
              {activeTab === "groups" && <GroupsTable groups={groups} />}
              {activeTab === "permissions" && (
                <PermissionsTable
                  draft={permissionDraft}
                  message={permissionMessage}
                  pending={permissionPending}
                  permissions={permissions}
                  onCreate={handleCreateGrant}
                  onDelete={handleDeleteGrant}
                  onDraftActionChange={handlePermissionDraftActionChange}
                  onDraftChange={setPermissionDraft}
                  onUpdate={handleUpdateGrant}
                />
              )}
              {activeTab === "audit" && <AuditLogTable logs={auditLogs} />}
            </>
          )}
        </section>
      </div>

      <aside className="xflow-review-card admin-console-summary-panel">
        <div className="xflow-review-card-header">
          <span className="xflow-review-icon"><ShieldCheck size={17} /></span>
          <div>
            <h2>운영 기준</h2>
            <p>현재 PR의 권한 적용 범위입니다.</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>인증</dt>
            <dd>Session cookie 우선</dd>
          </div>
          <div>
            <dt>관리 접근</dt>
            <dd>admin role 필요</dd>
          </div>
          <div>
            <dt>범위</dt>
            <dd>권한 조회/편집</dd>
          </div>
        </dl>
      </aside>
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

function UsersTable({ users }: { users: AdminUser[] }) {
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
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <strong>{user.displayName}</strong>
                <span>{user.email}</span>
              </td>
              <td><AdminChip>{user.role}</AdminChip></td>
              <td>{user.groups.map((group) => group.name).join(", ") || "-"}</td>
              <td>{user.permissionsSummary.canView} view · {user.permissionsSummary.canManage} manage</td>
              <td><AdminChip>{user.status}</AdminChip></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupsTable({ groups }: { groups: IdentityGroup[] }) {
  return (
    <div className="admin-console-table-scroll">
      <table className="schema-table admin-console-table">
        <thead>
          <tr>
            <th>그룹</th>
            <th>설명</th>
            <th>멤버</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.id}>
              <td><strong>{group.name}</strong><span>{group.id}</span></td>
              <td>{group.description || "-"}</td>
              <td>{typeof group.memberCount === "number" ? `${group.memberCount}명` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PermissionDraft = {
  actions: PermissionAction[];
  principalId: string;
  principalType: PermissionPrincipalType;
  resourceKey: string;
};

function PermissionsTable({
  draft,
  message,
  pending,
  permissions,
  onCreate,
  onDelete,
  onDraftActionChange,
  onDraftChange,
  onUpdate,
}: {
  draft: PermissionDraft;
  message: string | null;
  pending: boolean;
  permissions: AdminPermissionSummary[];
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onDelete: (resource: AdminPermissionSummary, grant: PermissionGrant) => void;
  onDraftActionChange: (action: PermissionAction, checked: boolean) => void;
  onDraftChange: React.Dispatch<React.SetStateAction<PermissionDraft>>;
  onUpdate: (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => void;
}) {
  return (
    <div className="admin-permission-editor">
      <form className="admin-permission-form" onSubmit={onCreate}>
        <label className="field">
          <span>리소스</span>
          <select value={draft.resourceKey} onChange={(event) => onDraftChange((current) => ({ ...current, resourceKey: event.target.value }))}>
            {permissions.map((resource) => (
              <option key={resourceKey(resource)} value={resourceKey(resource)}>
                {resource.resourceType} · {resource.resourceName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Principal</span>
          <select value={draft.principalType} onChange={(event) => onDraftChange((current) => ({ ...current, principalId: event.target.value === "public" ? "public" : current.principalId, principalType: event.target.value as PermissionPrincipalType }))}>
            {principalTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="field">
          <span>ID</span>
          <input
            disabled={draft.principalType === "public"}
            value={draft.principalType === "public" ? "public" : draft.principalId}
            onChange={(event) => onDraftChange((current) => ({ ...current, principalId: event.target.value }))}
          />
        </label>
        <div className="admin-permission-actions" aria-label="추가할 권한 action">
          {permissionOrder.map((action) => (
            <label key={action}>
              <input
                checked={draft.actions.includes(action)}
                type="checkbox"
                onChange={(event) => onDraftActionChange(action, event.target.checked)}
              />
              <span>{action}</span>
            </label>
          ))}
        </div>
        <button className="primary-button" type="submit" disabled={pending || permissions.length === 0}>
          <Plus size={16} />
          <span>Grant 추가</span>
        </button>
      </form>
      {message && <InfoBox title="권한 편집" body={message} />}

      <div className="admin-console-table-scroll">
        <table className="schema-table admin-console-table admin-permission-table">
          <thead>
            <tr>
              <th>리소스</th>
              <th>Owner</th>
              <th>Grant</th>
              <th>현재 권한</th>
            </tr>
          </thead>
          <tbody>
            {permissions.slice(0, 60).map((resource) => (
              <tr key={`${resource.resourceType}-${resource.resourceId}`}>
                <td><strong>{resource.resourceName}</strong><span>{resource.resourceType} · {resource.resourceId}</span></td>
                <td>{resource.owner || resource.createdBy || "-"}</td>
                <td>
                  <div className="admin-grant-list">
                    {resource.grants.map((grant, index) => (
                      <GrantEditor
                        grant={grant}
                        key={`${resource.resourceId}-${grant.id ?? grant.principalType}-${grant.principalId}-${index}`}
                        pending={pending}
                        resource={resource}
                        onDelete={onDelete}
                        onUpdate={onUpdate}
                      />
                    ))}
                    {resource.grants.length === 0 && <span className="admin-console-muted">grant 없음</span>}
                  </div>
                </td>
                <td>
                  <div className="admin-console-chip-row">
                    {permissionOrder.filter((action) => canAction(resource, action)).map((action) => (
                      <AdminChip key={`${resource.resourceId}-${action}`}>{action}</AdminChip>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <strong>{grant.principalType}:{grant.principalId}</strong>
        <span>{grant.source || "metadata"}</span>
      </div>
      <div className="admin-grant-actions" aria-label={`${grant.principalId} action`}>
        {permissionOrder.map((action) => (
          <label key={action}>
            <input
              checked={draftActions.includes(action)}
              disabled={!editable || pending}
              type="checkbox"
              onChange={(event) => toggleAction(action, event.target.checked)}
            />
            <span>{action}</span>
          </label>
        ))}
      </div>
      <div className="admin-grant-tools">
        <button className="icon-button" type="button" aria-label="grant 저장" disabled={!editable || pending} onClick={() => onUpdate(resource, grant, draftActions)}>
          <Save size={16} />
        </button>
        <button className="icon-button danger" type="button" aria-label="grant 삭제" disabled={!editable || pending} onClick={() => onDelete(resource, grant)}>
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}

function AuditLogTable({ logs }: { logs: AdminAuditLogEntry[] }) {
  return (
    <div className="admin-console-table-scroll">
      <table className="schema-table admin-console-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>Actor</th>
            <th>Target</th>
            <th>Result</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.requestId}>
              <td><strong>{log.action}</strong><span>{log.apiPath}</span></td>
              <td>{log.actorId}</td>
              <td>{log.targetType}:{log.targetId}</td>
              <td><AdminChip>{log.result}</AdminChip></td>
              <td>{formatTime(log.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminChip({ children }: { children: React.ReactNode }) {
  return <span className="admin-console-chip">{children}</span>;
}

function resourceKey(resource?: AdminPermissionSummary) {
  return resource ? `${resource.resourceType}:${resource.resourceId}` : "";
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

function formatTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}
