import type { LucideIcon } from "lucide-react";

export type FlowId = "jobs" | "jobDetail" | "jobRuns" | "source" | "recordParsing" | "schema" | "rules" | "repeat" | "manual" | "target" | "permission" | "review" | "catalog" | "catalogDetail" | "sql" | "dashboard" | "admin" | "profile" | "login";
export type ScheduleFlowId = Extract<FlowId, "repeat" | "manual">;
export type NavId = "ingest" | "catalog" | "sql" | "dashboard" | "admin";
export type NavItem = { id: NavId; label: string; icon: LucideIcon; flow: FlowId };
