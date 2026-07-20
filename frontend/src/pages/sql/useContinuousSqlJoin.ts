import { useEffect, useMemo, useState } from "react";

import { apiConfig } from "../../services/apiClient";
import {
  commandContinuousSqlJob,
  createContinuousSqlJob,
  getContinuousSqlJob,
  type ContinuousSqlJob,
  validateContinuousSqlPlan,
  verifyAndRegisterCatalogUniqueKey,
} from "../../services/continuousSqlApi";
import { getCatalogDataset } from "../../services/catalogApi";
import { createDashboard } from "../../services/dashboardApi";
import { createDashboardJobBinding } from "../../services/dashboardJobBindingApi";
import { getRealtimeFeatureConfig, type RealtimeFeatureConfig } from "../../services/realtimeConfigApi";
import { ApiError, type AuditResult, type CatalogDataset } from "../../types";
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
  const [dashboardBindingEnabled, setDashboardBindingEnabled] = useState(false);
  const [dashboardTitle, setDashboardTitle] = useState("");
  const [triggerIntervalSeconds, setTriggerIntervalSeconds] = useState(5);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ContinuousSqlJob | null>(null);
  const [catalogDataset, setCatalogDataset] = useState<CatalogDataset | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const relationMix = useMemo(() => getContinuousSqlRelationMix(selectedDatasets), [selectedDatasets]);
  const v2Enabled = Boolean(
    featureConfig?.clickhouseRealtimeV2Enabled
      && featureConfig.kafkaConnectSinkEnabled
      && featureConfig.clickhouseRealtimeConsumerOwner === "kafka_connect_v2",
  );
  const servingMode = featureConfig?.continuousSqlServingMode ?? "iceberg";
  const featureEnabled = Boolean(
    featureConfig?.continuousSqlJoinEnabled
      && (
        servingMode === "iceberg"
        || featureConfig.clickhouseContinuousJoinEnabled
        || v2Enabled
      ),
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

  useEffect(() => {
    if (!dialogOpen || !result || catalogDataset || result.observedState === "failed") return;
    let active = true;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const poll = async () => {
      try {
        const latest = await getContinuousSqlJob(result.id);
        if (!active) return;
        setResult(latest);
        if (latest.observedState === "failed") {
          setError(latest.lastErrorMessage || "실시간 JOIN 실행에 실패했습니다.");
          setProgressMessage(null);
          return;
        }
        if (latest.observedState !== "running") {
          setProgressMessage("Kafka 소비자와 JOIN 경로가 준비되는지 확인하고 있습니다.");
        } else {
          try {
            const published = await getCatalogDataset(latest.outputDatasetId);
            if (!active) return;
            if (published.status !== "available") {
              setProgressMessage("Kafka 소비 준비 완료 · 첫 실제 이벤트 게시를 기다리고 있습니다.");
              if (active) timer = globalThis.setTimeout(() => void poll(), 1_000);
              return;
            }
            setCatalogDataset(published);
            setProgressMessage("첫 실제 이벤트가 JOIN되어 GOLD 카탈로그와 대시보드 데이터 소스에 게시됐습니다.");
            return;
          } catch (catalogError) {
            if (!(catalogError instanceof ApiError) || catalogError.status !== 404) throw catalogError;
            setProgressMessage("Kafka 소비 준비 완료 · 첫 실제 이벤트가 들어오면 카탈로그와 대시보드에 즉시 게시됩니다.");
          }
        }
      } catch (pollError) {
        if (active) {
          setProgressMessage("상태 확인이 지연되어 1초 뒤 다시 확인합니다.");
          if (pollError instanceof ApiError && pollError.status < 500) setError(pollError.message);
        }
      }
      if (active) timer = globalThis.setTimeout(() => void poll(), 1_000);
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [catalogDataset, dialogOpen, result?.id]);

  const open = () => {
    if (!relationMix) return;
    setOutputName(buildContinuousSqlOutputName(relationMix.streamingDataset));
    setDashboardBindingEnabled(false);
    setDashboardTitle("");
    setTriggerIntervalSeconds(5);
    setError(null);
    setResult(null);
    setCatalogDataset(null);
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
    setCatalogDataset(null);
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
          setProgressMessage(`${dataset?.name ?? "정적 데이터셋"}의 JOIN 키를 실제 데이터 전체로 검사하고 자동 등록하고 있습니다.`);
          await verifyAndRegisterCatalogUniqueKey(issue.datasetId, issue.columns);
          setProgressMessage("유일키 등록이 완료되어 JOIN SQL을 다시 검증하고 있습니다.");
        }
      }
      setProgressMessage(
        servingMode === "iceberg"
          ? "정적 Iceberg 스냅샷을 고정하고 Spark 실시간 JOIN 경로를 시작하고 있습니다."
          : "정적 스냅샷을 ClickHouse에 준비하고 실시간 JOIN 경로를 시작하고 있습니다. 최초 1회는 데이터 크기에 따라 시간이 걸릴 수 있습니다.",
      );
      const commonCreateRequest = {
        ...planRequest,
        clientRequestId: createClientRequestId(),
        name: `${outputName.trim()} Continuous SQL`,
      };
      const job = servingMode === "iceberg"
        ? await createContinuousSqlJob({
          ...commonCreateRequest,
          output: {
            datasetId: outputIdentity.datasetId,
            datasetName: outputName.trim(),
            layer: "GOLD",
            servingMode: "iceberg",
          },
        })
        : await createContinuousSqlJob({
          ...commonCreateRequest,
          output: {
            clickhouseTarget: v2Enabled
              ? {
                  database: "asklake_realtime_v2",
                  engine: "clickhouse",
                  table: "serving_events_v2",
                }
              : {
                  database: "asklake",
                  engine: "clickhouse",
                  table: outputIdentity.table,
                },
            datasetId: outputIdentity.datasetId,
            datasetName: outputName.trim(),
            layer: "GOLD",
            servingMode: "clickhouse",
          },
        });
      const started = await commandContinuousSqlJob(job.id, "start", createClientRequestId());
      setResult(started.job);
      if (started.job.observedState === "failed") {
        throw new Error(started.job.lastErrorMessage || "실시간 JOIN 실행에 실패했습니다.");
      }
      setProgressMessage(
        started.job.observedState === "running"
          ? "Kafka 소비 준비 완료 · 첫 실제 이벤트를 기다리고 있습니다."
          : "Kafka 소비자와 JOIN 경로가 준비되는지 확인하고 있습니다.",
      );
      onAction(
        "analysis.continuous_sql.started",
        `/api/query/continuous-jobs/${encodeURIComponent(job.id)}/commands`,
        started.job.outputDatasetId,
      );
      if (dashboardBindingEnabled) {
        try {
          const { dashboard } = await createDashboard({
            source: "manual",
            title: dashboardTitle.trim() || `${outputName.trim()} Dashboard`,
          });
          await createDashboardJobBinding({
            dashboardId: dashboard.id,
            jobId: started.job.id,
            jobKind: "continuous_sql",
            outputDatasetId: started.job.outputDatasetId,
          });
          onAction("analysis.continuous_sql.dashboard_binding.created", "/api/dashboard-job-bindings", dashboard.id);
        } catch (bindingError) {
          const bindingMessage = bindingError instanceof Error ? bindingError.message : "Dashboard 연동 생성에 실패했습니다.";
          setError(`Continuous SQL Job은 시작됐지만 Dashboard 연동에 실패했습니다: ${bindingMessage}`);
          onAction("analysis.continuous_sql.dashboard_binding.failed", "/api/dashboard-job-bindings", started.job.id, "failed");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "실시간 JOIN Job을 만들지 못했습니다.");
      setProgressMessage(null);
      onAction("analysis.continuous_sql.failed", "/api/query/continuous-jobs", relationMix.streamingDataset.id, "failed");
    } finally {
      setPending(false);
    }
  };

  return {
    catalogDataset,
    create,
    dashboardBindingEnabled,
    dashboardTitle,
    dialogOpen,
    error,
    featureEnabled,
    open,
    outputName,
    pending,
    progressMessage,
    relationMix,
    result,
    servingMode,
    setDialogOpen,
    setDashboardBindingEnabled,
    setDashboardTitle,
    setOutputName,
    setTriggerIntervalSeconds,
    triggerIntervalSeconds,
  };
}
