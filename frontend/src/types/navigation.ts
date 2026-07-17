import type { LucideIcon } from "lucide-react";

export type FlowId = "jobs" | "jobDetail" | "jobRuns" | "source" | "recordParsing" | "schema" | "rules" | "repeat" | "manual" | "once" | "target" | "permission" | "review" | "catalog" | "catalogDetail" | "sql" | "dashboard" | "semantic" | "admin" | "profile" | "login";
export type ScheduleFlowId = Extract<FlowId, "repeat" | "manual" | "once">;
export type NavId = "ingest" | "catalog" | "sql" | "dashboard" | "semantic" | "admin";
export type NavItem = { id: NavId; label: string; icon: LucideIcon; flow: FlowId };
