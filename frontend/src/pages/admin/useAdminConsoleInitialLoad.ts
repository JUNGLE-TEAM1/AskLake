import { useEffect, useRef, useState } from "react";

import {
  fetchAdminAuditLogs,
  fetchAdminGovernanceControls,
  fetchAdminGroups,
  fetchAdminPermissions,
  fetchAdminUsers,
} from "../../services/adminApi";
import type {
  AdminAuditLogEntry,
  AdminPermissionSummary,
  AdminPrincipalControl,
  AdminResourceLock,
  AdminUser,
  IdentityGroup,
} from "../../types";
import {
  adminConsoleLoadSections,
  settleAdminConsoleRequests,
} from "./adminConsoleLoadState";
import type {
  AdminConsoleLoadFailure,
  AdminConsoleLoadSection,
} from "./adminConsoleLoadState";

export type AdminConsoleActionHandler = (
  action: string,
  apiPath: string,
  targetId: string,
  result?: "success" | "failed",
  options?: { targetType?: "admin_module" },
) => void;

export function useAdminConsoleInitialLoad(onAction: AdminConsoleActionHandler) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<IdentityGroup[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionSummary[]>([]);
  const [principalControls, setPrincipalControls] = useState<AdminPrincipalControl[]>([]);
  const [resourceLocks, setResourceLocks] = useState<AdminResourceLock[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<AdminConsoleLoadSection, AdminConsoleLoadFailure>>>({});
  const onActionRef = useRef(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    let active = true;
    settleAdminConsoleRequests({
      users: fetchAdminUsers(),
      groups: fetchAdminGroups(),
      permissions: fetchAdminPermissions(),
      governance: fetchAdminGovernanceControls(),
      audit: fetchAdminAuditLogs(),
    }).then(({ data, errors }) => {
      if (!active) return;
      if (data.users) setUsers(data.users.users);
      if (data.groups) setGroups(data.groups.groups);
      if (data.permissions) setPermissions(data.permissions.resources);
      if (data.governance) {
        setPrincipalControls(data.governance.principalControls);
        setResourceLocks(data.governance.resourceLocks);
      }
      if (data.audit) setAuditLogs(data.audit.logs);
      setLoadErrors(errors);

      const failedCount = adminConsoleLoadSections.filter((section) => errors[section]).length;
      const action = failedCount === 0
        ? "admin.console.loaded"
        : failedCount === adminConsoleLoadSections.length
          ? "admin.console.load_failed"
          : "admin.console.load_partial";
      onActionRef.current(action, "/api/admin", "admin-console", failedCount === 0 ? "success" : "failed", { targetType: "admin_module" });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  return {
    auditLogs,
    groups,
    loadErrors,
    loading,
    onActionRef,
    permissions,
    principalControls,
    resourceLocks,
    setAuditLogs,
    setLoadErrors,
    setPermissions,
    setPrincipalControls,
    setResourceLocks,
    users,
  };
}
