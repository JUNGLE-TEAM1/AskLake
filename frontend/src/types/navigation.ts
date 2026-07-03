import type { LucideIcon } from "lucide-react";

export type FlowId = "jobs" | "jobDetail" | "jobRuns" | "jobDag" | "source" | "schema" | "rules" | "repeat" | "manual" | "once" | "target" | "permission" | "review" | "catalog" | "catalogDetail" | "sql" | "dashboard" | "ai" | "admin";
export type ScheduleFlowId = Extract<FlowId, "repeat" | "manual" | "once">;
export type NavId = "ingest" | "catalog" | "sql" | "dashboard" | "ai" | "admin";
export type NavItem = { id: NavId; label: string; icon: LucideIcon; flow: FlowId };

