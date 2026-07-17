import { useEffect, useMemo, useState } from "react";

import { apiConfig } from "../../services/apiClient";
import {
  commandContinuousSqlJob,
  createClickHouseContinuousSqlJob,
  type ContinuousSqlJob,
  validateContinuousSqlPlan,
  verifyAndRegisterCatalogUniqueKey,
} from "../../services/continuousSqlApi";
import { getRealtimeFeatureConfig, type RealtimeFeatureConfig } from "../../services/realtimeConfigApi";
import type { AuditResult, CatalogDataset } from "../../types";
import {
  buildClickHouseOutputIdentity,
  buildContinuousSqlOutputName,
  getContinuousSqlUniqueKeyIssue,
  getContinuousSqlRelationMix,
} from "./continuousSqlUi";

function createClientRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `continuous-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function useContinuousSqlJoin({
  onAction,
  query,
  selectedDatasets,
}: {
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  query: string;
  selectedDatasets: CatalogDataset[];
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [featureConfig, setFeatureConfig] = useState<RealtimeFeatureConfig | null>(null);
  const [outputName, setOutputName] = useState("");
  const [triggerIntervalSeconds, setTriggerIntervalSeconds] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ContinuousSqlJob | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const relationMix = useMemo(() => getContinuousSqlRelationMix(selectedDatasets), [selectedDatasets]);
  const featureEnabled = Boolean(
    featureConfig?.continuousSqlJoinEnabled && featureConfig.clickhouseContinuousJoinEnabled,
  );

  useEffect(() => {
    if (apiConfig.useMock) return;
    let active = true;
    void getRealtimeFeatureConfig()
      .then((config) => {
        if (active) setFeatureConfig(config);
      })
      .catch(() => {
        if (active) setFeatureConfig(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const open = () => {
    if (!relationMix) return;
    setOutputName(buildContinuousSqlOutputName(relationMix.streamingDataset));
    setTriggerIntervalSeconds(1);
    setError(null);
    setResult(null);
    setProgressMessage(null);
    setDialogOpen(true);
    onAction("analysis.continuous_sql.opened", "/api/query/continuous-jobs/validate", relationMix.streamingDataset.id);
  };

  const create = async () => {
    if (!relationMix || !featureEnabled || pending || !outputName.trim()) return;
    const triggerSeconds = Math.max(1, Math.min(3600, Math.trunc(triggerIntervalSeconds)));
    const planRequest = {
      query,
      relationDatasetIds: selectedDatasets.map((item) => item.id),
      staticBindingPolicy: "PINNED_AT_START" as const,
      triggerIntervalSeconds: triggerSeconds,
    };
    const outputIdentity = buildClickHouseOutputIdentity();
    setPending(true);
    setError(null);
    setProgressMessage("SQL과 JOIN 구성을 검증하고 있습니다.");
    try {
      const registeredKeys = new Set<string>();
      while (true) {
        try {
          await validateContinuousSqlPlan(planRequest);
          break;
        } catch (validationError) {
          const issue = getContinuousSqlUniqueKeyIssue(validationError);
          const issueKey = issue ? `${issue.datasetId}:${issue.columns.join(",")}` : "";
          if (!issue || registeredKeys.has(issueKey)) throw validationError;
          registeredKeys.add(issueKey);
          const dataset = selectedDatasets.find((item) => item.id === issue.datasetId);
          setProgressMessage(`${dataset?.name ?? "정적 데이터셋"}의 JOIN 키를 실제 데이터로 검사하고 자동 등록하고 있습니다.`);
          await verifyAndRegisterCatalogUniqueKey(issue.datasetId, issue.columns);
          setProgressMessage("유일키 등록이 완료되어 JOIN 구성을 다시 검증하고 있습니다.");
        }
      }
      setProgressMessage("ClickHouse JOIN을 만들고 실행을 시작하고 있습니다.");
      const job = await createClickHouseContinuousSqlJob({
        ...planRequest,
        clientRequestId: createClientRequestId(),
        name: `${outputName.trim()} Continuous SQL`,
        output: {
          clickhouseTarget: { database: "asklake", engine: "clickhouse", table: outputIdentity.table },
          datasetId: outputIdentity.datasetId,
          datasetName: outputName.trim(),
          layer: "GOLD",
          servingMode: "clickhouse",
        },
      });
      const started = await commandContinuousSqlJob(job.id, "start", createClientRequestId());
      setResult(started.job);
      setProgressMessage(null);
      onAction(
        "analysis.continuous_sql.started",
        `/api/query/continuous-jobs/${encodeURIComponent(job.id)}/commands`,
        started.job.outputDatasetId,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실시간 JOIN Job을 만들지 못했습니다.");
      onAction("analysis.continuous_sql.failed", "/api/query/continuous-jobs", relationMix.streamingDataset.id, "failed");
    } finally {
      setPending(false);
      setProgressMessage(null);
    }
  };

  return {
    create,
    dialogOpen,
    error,
    featureEnabled,
    open,
    outputName,
    pending,
    progressMessage,
    relationMix,
    result,
    setDialogOpen,
    setOutputName,
    setTriggerIntervalSeconds,
    triggerIntervalSeconds,
  };
}
