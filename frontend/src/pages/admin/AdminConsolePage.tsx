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
      setPermissionMessage("하나 이상의 권한을 선택해주세요.");
      return;
    }
    if (permissionDraft.principalType !== "public" && !permissionDraft.principalId.trim()) {
      setPermissionMessage("권한을 부여할 대상을 선택해주세요.");
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
        setPermissionMessage("권한이 추가되었습니다.");
        onActionRef.current("admin.permission_grant.created", "/api/admin/permissions", resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 추가하지 못했습니다.";
        setPermissionMessage(message);
        onActionRef.current("admin.permission_grant.create_failed", "/api/admin/permissions", resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  const handleUpdateGrant = (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => {
    if (!grant.id) {
      setPermissionMessage("기본 권한은 직접 수정할 수 없습니다.");
      return;
    }
    if (actions.length === 0) {
      setPermissionMessage("권한 항목에는 하나 이상의 권한이 필요합니다.");
      return;
    }
    setPermissionPending(true);
    setPermissionMessage(null);
    updateAdminPermissionGrant(grant.id, { actions })
      .then((response) => {
        setPermissions(response.resources);
        setPermissionMessage("권한이 수정되었습니다.");
        onActionRef.current("admin.permission_grant.updated", `/api/admin/permissions/${grant.id}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 수정하지 못했습니다.";
        setPermissionMessage(message);
        onActionRef.current("admin.permission_grant.update_failed", `/api/admin/permissions/${grant.id}`, resource.resourceId, "failed", { targetType: "admin_module" });
      })
      .finally(() => setPermissionPending(false));
  };

  const handleDeleteGrant = (resource: AdminPermissionSummary, grant: PermissionGrant) => {
    if (!grant.id) {
      setPermissionMessage("기본 권한은 직접 삭제할 수 없습니다.");
      return;
    }
    setPermissionPending(true);
    setPermissionMessage(null);
    deleteAdminPermissionGrant(grant.id)
      .then((response) => {
        setPermissions(response.resources);
        setPermissionMessage("권한이 삭제되었습니다.");
        onActionRef.current("admin.permission_grant.deleted", `/api/admin/permissions/${grant.id}`, resource.resourceId, "success", { targetType: "admin_module" });
      })
      .catch((unknownError) => {
        const message = unknownError instanceof ApiError ? unknownError.message : "권한을 삭제하지 못했습니다.";
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
          description="사용자, 그룹, 리소스 권한, 감사 로그를 관리합니다."
          icon={<ShieldCheck size={28} />}
        />

        <div className="admin-console-metric-grid">
          <AdminMetric label="사용자" value={`${users.length}`} />
          <AdminMetric label="그룹" value={`${groups.length}`} />
          <AdminMetric label="권한 항목" value={`${totalPermissionGrants}`} />
          <AdminMetric label="감사 로그" value={`${auditLogs.length}`} />
        </div>

        <section className="xflow-review-card admin-console-panel">
          <div className="xflow-review-card-header">
            <span className="xflow-review-icon permission"><ShieldCheck size={17} /></span>
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
              {activeTab === "users" && <UsersTable users={users} />}
              {activeTab === "groups" && <GroupsTable groups={groups} />}
              {activeTab === "permissions" && (
                <PermissionsTable
                  draft={permissionDraft}
                  groups={groups}
                  message={permissionMessage}
                  pending={permissionPending}
                  permissions={permissions}
                  users={users}
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
  groups,
  message,
  pending,
  permissions,
  users,
  onCreate,
  onDelete,
  onDraftActionChange,
  onDraftChange,
  onUpdate,
}: {
  draft: PermissionDraft;
  groups: IdentityGroup[];
  message: string | null;
  pending: boolean;
  permissions: AdminPermissionSummary[];
  users: AdminUser[];
  onCreate: (event: React.FormEvent<HTMLFormElement>) => void;
  onDelete: (resource: AdminPermissionSummary, grant: PermissionGrant) => void;
  onDraftActionChange: (action: PermissionAction, checked: boolean) => void;
  onDraftChange: React.Dispatch<React.SetStateAction<PermissionDraft>>;
  onUpdate: (resource: AdminPermissionSummary, grant: PermissionGrant, actions: PermissionAction[]) => void;
}) {
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState<"all" | AdminResourceType>("all");
  const grantableUsers = users.filter((user) => user.role.toLowerCase() !== "admin");
  const principalOptions = draft.principalType === "group"
    ? groups.map((group) => ({ label: group.name, value: group.id }))
    : grantableUsers.map((user) => ({
      label: user.email ? `${user.displayName} · ${user.email}` : user.displayName,
      value: user.displayName,
    }));
  const hasPrincipalOptions = principalOptions.length > 0;
  const principalEmptyMessage = draft.principalType === "group"
    ? "권한을 부여할 그룹이 없습니다."
    : "권한을 부여할 일반 사용자가 없습니다.";
  const normalizedSearch = resourceSearch.trim().toLowerCase();
  const filteredResources = permissions.filter((resource) => {
    const matchesType = resourceTypeFilter === "all" || resource.resourceType === resourceTypeFilter;
    const searchTarget = `${resource.resourceName} ${resource.resourceId} ${resource.owner ?? ""} ${resource.createdBy ?? ""}`.toLowerCase();
    return matchesType && (!normalizedSearch || searchTarget.includes(normalizedSearch));
  });
  const selectedResource = filteredResources.find((resource) => resourceKey(resource) === draft.resourceKey)
    ?? filteredResources[0]
    ?? permissions.find((resource) => resourceKey(resource) === draft.resourceKey);

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
      {message && <InfoBox title="권한 편집" body={message} />}

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
                <div className="admin-console-chip-row">
                  {permissionOrder.filter((action) => canAction(selectedResource, action)).map((action) => (
                    <AdminChip key={`${selectedResource.resourceId}-${action}`}>{actionLabel(action)}</AdminChip>
                  ))}
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
                    const nextOptions = nextType === "group"
                      ? groups.map((group) => group.id)
                      : grantableUsers.map((user) => user.displayName);
                    onDraftChange((current) => ({
                      ...current,
                      principalId: nextOptions[0] || "",
                      principalType: nextType,
                      resourceKey: resourceKey(selectedResource),
                    }));
                  }}>
                    {principalTypeOptions.map((type) => <option key={type} value={type}>{principalTypeLabel(type)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>대상</span>
                  {hasPrincipalOptions ? (
                    <select
                      value={draft.principalId}
                      onChange={(event) => onDraftChange((current) => ({ ...current, principalId: event.target.value, resourceKey: resourceKey(selectedResource) }))}
                    >
                      {principalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  ) : (
                    <span className="admin-permission-empty-target">{principalEmptyMessage}</span>
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
                <button className="primary-button admin-grant-create-button" type="submit" disabled={pending || permissions.length === 0 || !hasPrincipalOptions} onClick={() => selectResource(selectedResource)}>
                  <Plus size={16} />
                  <span>권한 추가</span>
                </button>
              </form>

              <div className="admin-grant-list">
                {selectedResource.grants.map((grant, index) => (
                  <GrantEditor
                    grant={grant}
                    key={`${selectedResource.resourceId}-${grant.id ?? grant.principalType}-${grant.principalId}-${index}`}
                    pending={pending}
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

function AuditLogTable({ logs }: { logs: AdminAuditLogEntry[] }) {
  return (
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

function formatTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}
