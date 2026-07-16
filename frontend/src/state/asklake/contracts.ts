

import type { AuditResult, AuditTargetType } from "../../types";

export type WriteAuditLog = (action: string, apiPath: string, targetId: string, result?: AuditResult, options?: { targetType?: AuditTargetType }) => void;
