import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Braces,
  Cable,
  FileText
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { getDatasets } from "../../services/mockApi";
import { getSourceConnectorDefaults, listSourceAssets, testSourceConnector, type SourceConnectorAnalysis, type SourceConnectorDefaults } from "../../services/sourceConnectorService";
import type { AuditResult, CatalogDataset, DraftPipeline, DraftPipelinePatch, SchemaColumnDraft, SourceDraft } from "../../types";
import { sanitizeSourceConnectorFields } from "../../utils/sourceConnectorFields";
import {
  resolveRawTextPreviewLines,
  shouldShowJsonPreview,
  shouldShowRawTextPreview,
} from "../../utils/sourcePreview";
import { SourceAssetTree } from "./SourceAssetTree";
import { SourceExplorerWorkbench } from "./SourceExplorerWorkbench";
import { SourcePreviewDataTable } from "./SourcePreviewDataTable";
import { SourceRawSamplePreview } from "./SourceRawSamplePreview";

import { DataLakeDatasetList } from "./DataLakeDatasetList";
import { SourceChoiceStage, SourceConnectStage } from "./SourceConnectionStages";
import { buildSourceConnectionDefinitions } from "./sourceDefinitions";
import {
  FALLBACK_SOURCE_DEFAULTS,
  getInitialSourceStage,
  hasSqlResultPreviewConfig,
  isInternalSourceField,
  mergeConnectorAnalysisSourceConfig,
  mergeFieldRows,
  mergeRuntimeSourceDefaults,
  mergeSourceAssets,
  normalizeFolderPrefix,
  normalizeSourceConnectorDefaults,
  OBJECT_STORAGE_IS_AWS,
  patchConnectorAnalysisSourceConfig,
  publicConnectorAnalysis,
  publicSourceLog,
  requiredSourceConnectionFields,
  SOURCE_CONNECTION_STATUS_COPY,
  sourceAssetMatchesExplorer,
  sourceColumnLabel,
  sourceConfigValue,
  sourceExplorerConfig,
  sourceFieldLabel,
  sourceFieldRowsEqual,
  sourceFormatFromConfig,
  sourceLabelFromFields,
  sourceTypeLabel,
  upsertSourceFields
} from "./sourceModel";

export function SourceConnectionPage({
  draft,
  onAction,
  onDraftChange,
  onNotify,
  onPrev,
  onNext,
}: {
  draft: DraftPipeline;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [sourceType, setSourceType] = useState(draft.source.sourceType || "");
  const kafkaExecutionMode = draft.source.executionMode ?? "snapshot";
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const initialSqlResultReady = draft.source.sourceType === "SQL Result" && hasSqlResultPreviewConfig(draft.source.sourceConfig);
  const [connectionStatus, setConnectionStatus] = useState<SourceDraft["connectionStatus"]>(initialSqlResultReady ? "success" : "idle");
  const [connectionMessage, setConnectionMessage] = useState(
    initialSqlResultReady ? "SQL Preview 결과가 검증되었습니다." : "현재 설정으로 연결 테스트가 필요합니다.",
  );
  const [sourceRuntime, setSourceRuntime] = useState<SourceConnectorAnalysis | null>(null);
  const [sourceStage, setSourceStage] = useState<"choose" | "connect" | "browse">(() => getInitialSourceStage(draft));
  const [loadingAssetPath, setLoadingAssetPath] = useState("");
  const [selectedAssetPath, setSelectedAssetPath] = useState("");
  const [assetPathQuery, setAssetPathQuery] = useState("");
  const [assetSearchQuery, setAssetSearchQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState("all");
  const [catalogDatasets, setCatalogDatasets] = useState<CatalogDataset[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedCatalogDatasetId, setSelectedCatalogDatasetId] = useState(
    draft.source.sourceType === "Data Lake" ? sourceConfigValue(draft.source.sourceConfig, "Source Dataset ID") : "",
  );
  const [continuousAdvancedOpen, setContinuousAdvancedOpen] = useState(false);
  const [sourceDefaults, setSourceDefaults] = useState<SourceConnectorDefaults>(FALLBACK_SOURCE_DEFAULTS);
  const [sourceDefaultsLoaded, setSourceDefaultsLoaded] = useState(false);
  const pristineSourceDraftRef = useRef(!draft.source.sourceType && draft.source.sourceConfig.length === 0);
  const appliedSourceDefaultsRef = useRef(new Set<string>());
  const sourceLocked = connectionStatus === "testing";

  useEffect(() => {
    if (!sourceType || sourceType === "SQL Result") return;
    setConnectionStatus("idle");
    setConnectionMessage("현재 설정으로 연결 테스트가 필요합니다.");
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setAssetPathQuery("");
    setAssetSearchQuery("");
    setAssetFilter("all");
  }, [sourceType]);

  const continuousConfig = draft.source.continuousConfig ?? {
    initialOffsetPolicy: "earliest" as const,
    triggerIntervalSeconds: 30,
    maxOffsetsPerTrigger: 10000,
  };
  const updateContinuousConfig = (patch: Partial<typeof continuousConfig>) => {
    onDraftChange({
      source: {
        executionMode: "continuous",
        continuousConfig: { ...continuousConfig, ...patch },
      },
      target: { format: "parquet" },
    });
  };
  useEffect(() => {
    let active = true;
    getSourceConnectorDefaults()
      .then((defaults) => {
        if (!active) return;
        setSourceDefaults(normalizeSourceConnectorDefaults(defaults));
        setSourceDefaultsLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const { connectorMeta, sourceConfigs } = buildSourceConnectionDefinitions(sourceDefaults);
  const selectedSourceType = sourceType === "Database" ? "PostgreSQL" : sourceType;
  const activeSourceType = sourceConfigs[selectedSourceType] ? selectedSourceType : "";
  const hasSelectedSource = activeSourceType.length > 0;
  const current = hasSelectedSource ? sourceConfigs[activeSourceType] : sourceConfigs["File / S3"];
  const isInternalDataLake = activeSourceType === "Data Lake";
  const editableFields = sourceFields[activeSourceType] ?? (
    draft.source.sourceType === activeSourceType && draft.source.sourceConfig.length > 0
      ? mergeFieldRows(current.fields, draft.source.sourceConfig)
      : current.fields
  );
  const isSqlResultSource = activeSourceType === "SQL Result";
  const hasSqlResultPreview = isSqlResultSource && hasSqlResultPreviewConfig(editableFields);

  useEffect(() => {
    if (!isInternalDataLake || sourceStage !== "browse") return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError("");
    void getDatasets()
      .then((datasets) => {
        if (cancelled) return;
        setCatalogDatasets(datasets.filter((dataset) => dataset.permissions?.canView !== false));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogDatasets([]);
        setCatalogError(error instanceof Error ? error.message : "데이터셋 목록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isInternalDataLake, sourceStage]);

  const usableCatalogDatasets = catalogDatasets.filter((dataset) => dataset.status === "available");
  const filteredCatalogDatasets = usableCatalogDatasets.filter((dataset) => {
    const query = assetSearchQuery.trim().toLowerCase();
    const matchesQuery = !query || [dataset.name, dataset.description, dataset.owner, ...dataset.tags]
      .some((value) => value.toLowerCase().includes(query));
    const matchesLayer = assetFilter === "all" || dataset.layer === assetFilter;
    return matchesQuery && matchesLayer;
  });
  const selectedCatalogDataset = usableCatalogDatasets.find((dataset) => dataset.id === selectedCatalogDatasetId) ?? null;
  const sourceLabel = hasSelectedSource
    ? editableFields.find(([label]) => ["Source Dataset", "SQL Run ID", "Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? activeSourceType
    : "미선택";
  const missingConnectionFields = requiredSourceConnectionFields(activeSourceType).filter((label) => !sourceConfigValue(editableFields, label).trim());
  const displayTestItems = (sourceRuntime?.testItems ?? current.testItems).filter(([label]) => !isInternalSourceField(label));
  const displayAssets = sourceRuntime?.assets ?? current.assets;
  const explorerConfig = sourceExplorerConfig(activeSourceType, displayAssets);
  const filteredDisplayAssets = displayAssets.filter((asset) => sourceAssetMatchesExplorer(asset, assetSearchQuery, assetFilter, explorerConfig.filterMode));
  const hasDetectedAssets = displayAssets.length > 0;
  const selectedAsset = selectedAssetPath ? displayAssets.find(([path]) => path === selectedAssetPath) ?? null : null;
  const selectedDatasetSummary = sourceRuntime?.datasetSummary;
  const isPrefixSelection = sourceConfigValue(editableFields, "__Selection Kind").toLowerCase() === "prefix"
    || selectedDatasetSummary?.selectionKind === "prefix";
  const requiresAssetSelectionForPreview = ["File / S3", "MongoDB", "PostgreSQL"].includes(activeSourceType);
  const selectedAssetHasSample = Boolean(
    (!requiresAssetSelectionForPreview || selectedAssetPath) && sourceRuntime?.previewColumns?.length,
  );
  const displayPreviewColumns = selectedAssetHasSample ? sourceRuntime?.previewColumns ?? [] : [];
  const displayPreviewRows = selectedAssetHasSample ? sourceRuntime?.previewRows ?? [] : [];
  const rawTextPreviewLines = resolveRawTextPreviewLines({
    backendRawLines: sourceRuntime?.draftPatch.source?.rawPreviewLines,
    columnLabels: displayPreviewColumns,
    rows: displayPreviewRows,
  });
  const previewShowsRawText = shouldShowRawTextPreview({
    detectedFormat: sourceRuntime?.draftPatch.source?.detectedFormat,
    requiresRecordParsing: sourceRuntime?.draftPatch.source?.requiresRecordParsing,
    rawLines: rawTextPreviewLines,
    sourceType: activeSourceType,
  });
  const previewShowsJson = shouldShowJsonPreview({
    detectedFormat: sourceRuntime?.draftPatch.source?.detectedFormat,
    requiresRecordParsing: sourceRuntime?.draftPatch.source?.requiresRecordParsing,
    rawLines: rawTextPreviewLines,
    sourceType: activeSourceType,
  });
  const previewShowsRawValue = previewShowsRawText || previewShowsJson;
  const runtimeSchemaColumnCount = sourceRuntime?.draftPatch.schema?.columns?.length ?? 0;
  const hasSchemaPatch = Boolean(runtimeSchemaColumnCount && sourceRuntime?.draftPatch.schema?.sampleRows?.length);
  const hasValidatedSchema = isPrefixSelection
    ? Boolean(selectedDatasetSummary?.schemaCompatible && selectedDatasetSummary.fileCount > 0 && runtimeSchemaColumnCount > 0)
    : hasSchemaPatch || draft.schema.columns.length > 0;
  const displayPreviewNote = sourceRuntime?.previewNote ?? current.previewNote;
  const publicConnectionMessage = publicSourceLog(connectionMessage);
  const publicDisplayPreviewNote = publicSourceLog(displayPreviewNote);
  const runtimeSourceConfig = sourceRuntime?.draftPatch.source?.sourceConfig;
  const verifiedSourceFields = connectionStatus === "success" && runtimeSourceConfig ? runtimeSourceConfig : editableFields;
  const displayPreviewFormat = previewShowsRawValue
    ? sourceRuntime?.draftPatch.source?.detectedFormat ?? "TXT"
    : selectedDatasetSummary?.format
    || (activeSourceType === "File / S3" ? sourceFormatFromConfig(verifiedSourceFields) : sourceTypeLabel(activeSourceType));
  const previewShowsFileList = activeSourceType === "File / S3"
    && displayPreviewColumns.includes("Object Key");
  const previewShowsTopicInfo = activeSourceType === "Stream / Kafka"
    && displayPreviewColumns.includes("Leader");
  const sourcePreviewTitle = previewShowsFileList
    ? "파일 목록"
    : previewShowsTopicInfo
      ? "토픽 정보"
      : "데이터 미리보기";
  const sourceSummaryRows: Array<[string, string]> = [
    ["선택 커넥터", hasSelectedSource ? sourceTypeLabel(activeSourceType) : "미선택"],
    ["연결 상태", isSqlResultSource ? (hasSqlResultPreview && connectionStatus === "success" ? "SQL Preview 검증됨" : "SQL Preview 필요") : connectionStatus === "success" ? publicConnectionMessage : connectionStatus === "testing" ? "테스트 중" : connectionStatus === "failed" ? "실패" : "테스트 필요"],
    ["감지 파일", isSqlResultSource ? `${sourceConfigValue(editableFields, "Preview Row Count") || "0"} rows` : `${displayAssets.length}개`],
    ["인증 방식", isSqlResultSource ? "SQL Preview 검증" : isInternalDataLake ? "AskLake 로그인 권한" : activeSourceType === "File / S3" ? (OBJECT_STORAGE_IS_AWS ? "EC2 IAM Role" : "MinIO 액세스 키") : "백엔드 커넥터"],
    ["다음 단계", isSqlResultSource ? "Review 확인" : (sourceRuntime?.draftPatch.source?.requiresRecordParsing ? "레코드 구조화" : "스키마 추론")],
  ];

  const applySourceDraft = (
    nextType = activeSourceType,
    nextFields = verifiedSourceFields,
    nextStatus = connectionStatus,
    nextMessage = connectionMessage,
  ) => {
    if (!nextType) {
      onDraftChange({
        source: {
          connectionMessage: nextMessage,
          connectionStatus: nextStatus,
          sourceConfig: [],
          sourceLabel: "",
          sourceType: "",
        },
      });
      return;
    }
    const persistedFields = sanitizeSourceConnectorFields(nextType, nextFields);
    const label = sourceLabelFromFields(nextType, persistedFields);
    const executionMode = nextType === "Stream / Kafka" ? draft.source.executionMode ?? "snapshot" : "snapshot";
    onDraftChange({
      source: {
        connectionMessage: nextMessage,
        connectionStatus: nextStatus,
        sourceConfig: persistedFields,
        sourceLabel: label,
        sourceType: nextType,
        executionMode,
        continuousConfig: executionMode === "continuous" ? draft.source.continuousConfig : undefined,
      },
    });
  };

  useEffect(() => {
    if (
      !sourceDefaultsLoaded
      || !pristineSourceDraftRef.current
      || appliedSourceDefaultsRef.current.has(activeSourceType)
      || connectionStatus !== "idle"
      || !["File / S3", "Stream / Kafka"].includes(activeSourceType)
    ) return;

    const nextFields = mergeRuntimeSourceDefaults(activeSourceType, editableFields, sourceDefaults);
    appliedSourceDefaultsRef.current.add(activeSourceType);
    if (sourceFieldRowsEqual(nextFields, editableFields)) return;

    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    applySourceDraft(activeSourceType, nextFields, connectionStatus, connectionMessage);
  }, [
    activeSourceType,
    connectionStatus,
    sourceDefaults.kafkaBroker,
    sourceDefaults.kafkaTopic,
    sourceDefaults.s3Bucket,
    sourceDefaults.s3Prefix,
    sourceDefaultsLoaded,
  ]);

  const selectSource = (value: string) => {
    const nextFields = value === activeSourceType ? editableFields : sourceFields[value] ?? sourceConfigs[value].fields;
    const nextIsSqlResult = value === "SQL Result";
    const nextIsInternalDataLake = value === "Data Lake";
    const nextHasSqlResultPreview = nextIsSqlResult && hasSqlResultPreviewConfig(nextFields);
    const nextStatus: SourceDraft["connectionStatus"] = nextIsInternalDataLake
      ? "success"
      : nextIsSqlResult
        ? (nextHasSqlResultPreview ? "success" : "idle")
        : "idle";
    const nextMessage = nextIsSqlResult
      ? nextHasSqlResultPreview
        ? "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다."
        : "SQL Result는 SQL 분석 Preview에서 처리 Job 생성으로 진입할 때 사용합니다."
      : nextIsInternalDataLake
        ? "현재 사용자의 Catalog 접근 권한으로 데이터셋을 탐색합니다."
        : `${sourceTypeLabel(value)} 설정을 선택했습니다. 검토 전에 연결 테스트를 실행하세요.`;
    setSourceType(value);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    if (!nextIsInternalDataLake) setSelectedCatalogDatasetId("");
    setConnectionStatus(nextStatus);
    setConnectionMessage(nextMessage);
    applySourceDraft(value, nextFields, nextStatus, nextMessage);
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const selectCatalogDataset = (dataset: CatalogDataset) => {
    const nextFields: Array<[string, string]> = [
      ["Source Dataset", dataset.name],
      ["Source Dataset ID", dataset.id],
    ];
    const schemaColumns: SchemaColumnDraft[] = dataset.schema.map(([name, type]) => ({
      nullable: true,
      sourceName: name,
      targetName: name,
      type,
    }));
    const message = `${dataset.name} 데이터셋을 소스로 선택했습니다.`;
    const schemaSummary = `${dataset.name} · ${schemaColumns.length}개 필드 · Catalog 권한 확인`;
    const draftPatch: DraftPipelinePatch = {
      schema: {
        columns: schemaColumns,
        sampleRows: dataset.sampleRows,
        summary: schemaSummary,
      },
      source: {
        connectionMessage: message,
        connectionStatus: "success",
        executionMode: "snapshot",
        sourceConfig: nextFields,
        sourceLabel: dataset.name,
        sourceType: "Data Lake",
      },
    };
    setSelectedCatalogDatasetId(dataset.id);
    setSourceFields((fields) => ({ ...fields, "Data Lake": nextFields }));
    setConnectionStatus("success");
    setConnectionMessage(message);
    setSourceRuntime({
      actionPath: `/api/catalog/datasets/${encodeURIComponent(dataset.id)}`,
      assets: [],
      draftPatch,
      logs: [message],
      message,
      previewColumns: dataset.schema.map(([name]) => name),
      previewNote: `${dataset.name}의 Catalog 샘플 행입니다.`,
      previewRows: dataset.sampleRows,
      status: "success",
      testItems: [],
    });
    onDraftChange(draftPatch);
    onAction("etl.source.catalog_dataset_selected", `/api/catalog/datasets/${encodeURIComponent(dataset.id)}`, dataset.id);
    onNotify(message);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    const nextMessage = isSqlResultSource ? connectionMessage : "소스 설정이 변경되었습니다. 연결 테스트를 다시 실행하세요.";
    const nextStatus = isSqlResultSource ? connectionStatus : "idle";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime(null);
    setSelectedAssetPath("");
    setConnectionStatus(nextStatus);
    setConnectionMessage(nextMessage);
    applySourceDraft(activeSourceType, nextFields, nextStatus, nextMessage);
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
  };

  const updateCollectionConfig = (patches: Array<[string, string]>) => {
    const nextFields = upsertSourceFields(editableFields, [...patches, ["__Sample Object", ""]]);
    const nextMessage = "파일 수집 범위가 변경되었습니다. 대표 파일을 다시 샘플링하세요.";
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setSourceRuntime((runtime) => runtime ? {
      ...runtime,
      draftPatch: {},
      logs: [nextMessage],
      message: nextMessage,
      previewColumns: [],
      previewNote: "수집 범위를 다시 검증한 뒤 미리보기를 확인할 수 있습니다.",
      previewRows: [],
      status: "idle",
    } : null);
    setConnectionStatus("idle");
    setConnectionMessage(nextMessage);
    setSourceStage("connect");
    applySourceDraft(activeSourceType, nextFields, "idle", nextMessage);
    onDraftChange({
      quality: {
        invalidRows: [],
        rules: [],
        score: undefined,
        status: "idle",
        summary: "스키마 재추론 후 품질 규칙 설정 필요",
      },
      recordParsing: {
        columns: [],
        delimiterKind: "whitespace",
        delimiterPattern: "\\s+",
        enabled: false,
        expectedFieldCount: 0,
        header: false,
      },
      schema: {
        columns: [],
        sampleRows: [],
        schemaFingerprint: undefined,
        summary: "수집 범위 변경 · 스키마 재추론 필요",
      },
      source: {
        detectedFormat: undefined,
        rawPreviewLines: [],
        requiresRecordParsing: false,
      },
      transform: {
        outputColumns: [],
        steps: [],
        summary: "스키마 재추론 후 변환 설정 필요",
      },
    });
  };

  const loadSourceAssetChildren = async (folderPath: string) => {
    if (!hasSelectedSource || activeSourceType !== "File / S3") return;
    const folderPrefix = normalizeFolderPrefix(folderPath);
    setLoadingAssetPath(folderPrefix);
    try {
      const result = await listSourceAssets(activeSourceType, editableFields, folderPrefix);
      setSourceRuntime((runtime) => runtime
        ? { ...runtime, assets: mergeSourceAssets(runtime.assets ?? [], result.assets ?? []) }
        : {
          actionPath: "/api/etl/sources/assets",
          assets: result.assets ?? [],
          draftPatch: {},
          logs: [],
          message: connectionMessage,
          previewColumns: [],
          previewNote: "",
          previewRows: [],
          status: connectionStatus,
          testItems: displayTestItems,
        });
      onAction("etl.source.folder_opened", "/api/etl/sources/assets", folderPrefix);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "하위 목록을 가져오지 못했습니다.");
    } finally {
      setLoadingAssetPath("");
    }
  };

  const navigateSourceAssetPath = async () => {
    const requestedPath = assetPathQuery.trim();
    if (!requestedPath) {
      onNotify("이동할 경로 또는 프리픽스를 입력하세요.");
      return;
    }
    await loadSourceAssetChildren(requestedPath);
  };

  const selectSourceAsset = async (assetPath: string) => {
    const asset = displayAssets.find(([path]) => path === assetPath);
    if (!asset) return;
    const [, assetMeta] = asset;
    if (assetMeta === "folder" || assetPath.endsWith("/")) {
      await loadSourceAssetChildren(assetPath);
      return;
    }
    const currentAssets = displayAssets;
    const nextFields = upsertSourceFields(editableFields.map(([fieldLabel, fieldValue]) => (
      fieldLabel === "Path / Prefix" || fieldLabel === "Path" || fieldLabel === "DATASET OR TABLE SELECTOR"
        ? [fieldLabel, assetPath] as [string, string]
        : [fieldLabel, fieldValue] as [string, string]
    )), [
      ["__Selection Kind", "file"],
      ["__Selected Object", assetPath],
      ["__Sample Object", assetPath],
    ]);
    const selectedTargetKind = activeSourceType === "PostgreSQL"
      ? "테이블"
      : activeSourceType === "MongoDB"
        ? "컬렉션"
        : assetMeta === "folder"
          ? "폴더"
          : "파일";
    const nextMessage = `${selectedTargetKind} ${assetPath} 선택됨`;
    setSelectedAssetPath(assetPath);
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setConnectionMessage(nextMessage);
    setConnectionStatus("testing");
    applySourceDraft(activeSourceType, nextFields, "testing", nextMessage);
    onDraftChange({ recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false } });
    onAction("etl.source.asset_selected", "/api/etl/sources/assets", assetPath);
    try {
      const result = patchConnectorAnalysisSourceConfig(
        mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, nextFields)),
          nextFields,
        ),
        nextFields,
        [
          ["__Selection Kind", "file"],
          ["__Selected Object", assetPath],
          ["__Sample Object", assetPath],
        ],
      );
      const successMessage = `${assetPath} 기준 샘플을 가져왔습니다.`;
      if (result.draftPatch.source?.sourceConfig) {
        setSourceFields((fields) => ({ ...fields, [activeSourceType]: result.draftPatch.source?.sourceConfig ?? nextFields }));
      }
      setSourceRuntime({ ...result, assets: mergeSourceAssets(currentAssets, result.assets ?? []), message: successMessage });
      setConnectionStatus(result.status);
      setConnectionMessage(successMessage);
      onDraftChange(result.draftPatch);
      onAction("etl.source.asset_sampled", result.actionPath, assetPath);
      onNotify(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "선택한 오브젝트의 샘플을 가져오지 못했습니다.";
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, nextFields, "failed", message);
      onAction("etl.source.asset_sample_failed", "/api/etl/sources/test", assetPath, "failed");
      onNotify(message);
    }
  };

  const selectSourceFolder = async (folderPath: string) => {
    if (activeSourceType !== "File / S3") return;
    const folderPrefix = normalizeFolderPrefix(folderPath);
    if (!folderPrefix) {
      onNotify("버킷 루트가 아닌 데이터셋 폴더를 선택하세요.");
      return;
    }

    const currentAssets = displayAssets;
    const nextFields = upsertSourceFields(editableFields.map(([fieldLabel, fieldValue]) => (
      fieldLabel === "Path / Prefix"
        ? [fieldLabel, folderPrefix] as [string, string]
        : [fieldLabel, fieldValue] as [string, string]
    )), [
      ["__Selection Kind", "prefix"],
      ["__Selected Object", ""],
      ["__Sample Object", ""],
    ]);
    const testingMessage = `${folderPrefix} 폴더를 데이터셋으로 검사하고 있습니다.`;
    setSelectedAssetPath(folderPrefix);
    setSourceFields((fields) => ({ ...fields, [activeSourceType]: nextFields }));
    setConnectionMessage(testingMessage);
    setConnectionStatus("testing");
    setSourceRuntime((runtime) => runtime ? {
      ...runtime,
      datasetSummary: undefined,
      draftPatch: { ...runtime.draftPatch, schema: undefined },
      previewColumns: [],
      previewRows: [],
    } : runtime);
    applySourceDraft(activeSourceType, nextFields, "testing", testingMessage);
    onDraftChange({
      recordParsing: { columns: [], delimiterKind: "whitespace", delimiterPattern: "\\s+", enabled: false, expectedFieldCount: 0, header: false },
      schema: { columns: [], sampleRows: [], summary: "" },
    });
    onAction("etl.source.prefix_selected", "/api/etl/sources/test", folderPrefix);

    try {
      const result = patchConnectorAnalysisSourceConfig(
        mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, nextFields)),
          nextFields,
        ),
        nextFields,
        [
          ["Path / Prefix", folderPrefix],
          ["__Selection Kind", "prefix"],
          ["__Selected Object", ""],
          ["__Sample Object", ""],
        ],
      );
      const summary = result.datasetSummary;
      const hasSchema = Boolean(result.draftPatch.schema?.columns?.length);
      const prefixIsValid = Boolean(
        result.status === "success"
        && summary?.selectionKind === "prefix"
        && summary.schemaCompatible
        && summary.fileCount > 0
        && hasSchema,
      );
      const nextStatus: SourceDraft["connectionStatus"] = prefixIsValid ? "success" : "failed";
      const nextMessage = !summary
        ? `${folderPrefix} Prefix 검사 결과를 확인하지 못했습니다.`
        : summary.fileCount === 0
          ? `${folderPrefix} 아래에서 처리할 데이터 파일을 찾지 못했습니다.`
          : !summary.schemaCompatible
            ? `${folderPrefix} 아래 ${summary.fileCount.toLocaleString()}개 파일의 스키마가 호환되지 않습니다.`
            : !hasSchema
              ? `${folderPrefix} 대표 파일의 스키마를 확인하지 못했습니다.`
              : result.status !== "success"
                ? result.message || `${folderPrefix} 데이터셋 검증에 실패했습니다.`
                : `${folderPrefix} 데이터셋 검증 완료: ${summary.fileCount.toLocaleString()}개 파일`;
      const normalizedResult: SourceConnectorAnalysis = {
        ...result,
        draftPatch: {
          ...result.draftPatch,
          source: result.draftPatch.source ? {
            ...result.draftPatch.source,
            connectionMessage: nextMessage,
            connectionStatus: nextStatus,
          } : result.draftPatch.source,
        },
        message: nextMessage,
        status: nextStatus,
      };
      if (normalizedResult.draftPatch.source?.sourceConfig) {
        setSourceFields((fields) => ({ ...fields, [activeSourceType]: normalizedResult.draftPatch.source?.sourceConfig ?? nextFields }));
      }
      setSourceRuntime({ ...normalizedResult, assets: mergeSourceAssets(currentAssets, normalizedResult.assets ?? []) });
      setConnectionStatus(nextStatus);
      setConnectionMessage(nextMessage);
      onDraftChange(normalizedResult.draftPatch);
      onAction(
        prefixIsValid ? "etl.source.prefix_sampled" : "etl.source.prefix_validation_failed",
        normalizedResult.actionPath,
        folderPrefix,
        prefixIsValid ? undefined : "failed",
      );
      onNotify(nextMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "선택한 Prefix의 샘플을 가져오지 못했습니다.";
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, nextFields, "failed", message);
      onAction("etl.source.prefix_sample_failed", "/api/etl/sources/test", folderPrefix, "failed");
      onNotify(message);
    }
  };

  const testConnection = async () => {
    if (!hasSelectedSource) {
      onNotify("먼저 소스를 선택하세요.");
      return;
    }
    if (isSqlResultSource) {
      const message = hasSqlResultPreview
        ? "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다."
        : "SQL 분석에서 Preview를 실행한 뒤 처리 Job 생성으로 진입해 주세요.";
      const nextStatus: SourceDraft["connectionStatus"] = hasSqlResultPreview ? "success" : "idle";
      setConnectionStatus(nextStatus);
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, editableFields, nextStatus, message);
      onNotify(message);
      return;
    }
    if (isInternalDataLake) {
      onNotify("AskLake 데이터 레이크는 별도 연결 테스트 없이 Catalog 권한으로 탐색합니다.");
      return;
    }
    if (missingConnectionFields.length > 0) {
      onNotify(`${missingConnectionFields.map(sourceFieldLabel).join(", ")} 값을 입력하세요.`);
      return;
    }

    const testingMessage = `${sourceTypeLabel(activeSourceType)} 커넥터 테스트 실행 중입니다.`;
    setConnectionStatus("testing");
    setConnectionMessage(testingMessage);
    setSourceRuntime(null);
    setSelectedAssetPath("");
    applySourceDraft(activeSourceType, editableFields, "testing", testingMessage);
    try {
      if (!["File / S3", "MongoDB", "PostgreSQL"].includes(activeSourceType)) {
        const result = mergeConnectorAnalysisSourceConfig(
          publicConnectorAnalysis(await testSourceConnector(activeSourceType, editableFields)),
          editableFields,
        );
        if (result.draftPatch.source?.sourceConfig) {
          setSourceFields((fields) => ({ ...fields, [activeSourceType]: result.draftPatch.source?.sourceConfig ?? editableFields }));
        }
        setSourceRuntime(result);
        setSelectedAssetPath("");
        setConnectionStatus(result.status);
        setConnectionMessage(result.message);
        onDraftChange(result.draftPatch);
        onAction("etl.source.connection_tested", result.actionPath, activeSourceType);
        onNotify(result.message);
        return;
      }
      const result = await listSourceAssets(activeSourceType, editableFields, "");
      const discoveredTargetLabel = activeSourceType === "PostgreSQL"
        ? "테이블"
        : activeSourceType === "MongoDB"
          ? "컬렉션"
          : "하위 항목";
      const successMessage = `${sourceTypeLabel(activeSourceType)} 연결 성공: ${discoveredTargetLabel} ${result.assets.length}개 탐색 가능`;
      const connectionTestItems: Array<[string, string]> = activeSourceType === "PostgreSQL"
        ? [
          ["Endpoint", `${sourceConfigValue(editableFields, "Endpoint / Host")}:${sourceConfigValue(editableFields, "Port")}`],
          ["Database", sourceConfigValue(editableFields, "Database Name")],
          ["Tables", String(result.assets.length)],
        ]
        : activeSourceType === "MongoDB"
          ? [
            ["Endpoint", `${sourceConfigValue(editableFields, "Endpoint / Host")}:${sourceConfigValue(editableFields, "Port")}`],
            ["Database", sourceConfigValue(editableFields, "Database Name")],
            ["Collections", String(result.assets.length)],
          ]
          : [
            ["Connector", activeSourceType],
            ["Result", "Verified"],
            ["Objects", String(result.assets.length)],
          ];
      const persistedFields = sanitizeSourceConnectorFields(activeSourceType, editableFields);
      const connectorResult: SourceConnectorAnalysis = {
        actionPath: "/api/etl/sources/assets",
        assets: result.assets,
        draftPatch: {
          source: {
            connectionMessage: successMessage,
            connectionStatus: "success",
            sourceConfig: persistedFields,
            sourceLabel: sourceLabelFromFields(activeSourceType, persistedFields),
            sourceType: activeSourceType,
          },
        },
        logs: [successMessage],
        message: successMessage,
        previewColumns: [],
        previewNote: `${discoveredTargetLabel}을 선택하면 제한 샘플과 스키마 추론 결과가 표시됩니다.`,
        previewRows: [],
        status: "success",
        testItems: connectionTestItems,
      };
      setSourceRuntime(connectorResult);
      setSelectedAssetPath("");
      setConnectionStatus("success");
      setConnectionMessage(successMessage);
      onDraftChange({
        ...connectorResult.draftPatch,
        schema: { columns: [], sampleRows: [], summary: "" },
      });
      onAction("etl.source.connection_tested", connectorResult.actionPath, activeSourceType);
      onNotify(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "소스 커넥터 테스트에 실패했습니다.";
      setSourceRuntime(null);
      setConnectionStatus("failed");
      setConnectionMessage(message);
      applySourceDraft(activeSourceType, editableFields, "failed", message);
      onAction("etl.source.connection_failed", "/api/etl/sources/test", activeSourceType, "failed");
      onNotify(message);
    }
  };

  const goNext = () => {
    if (!hasSelectedSource) {
      onNotify("먼저 소스를 선택하세요.");
      return;
    }
    if (sourceStage === "choose") {
      setSourceStage(isInternalDataLake ? "browse" : "connect");
      return;
    }
    if (!isInternalDataLake && connectionStatus !== "success") {
      onNotify(isSqlResultSource ? "SQL 분석에서 Preview를 실행한 뒤 처리 Job 생성으로 진입해 주세요." : "먼저 소스 연결 테스트를 성공시켜야 스키마 단계로 넘어갈 수 있습니다.");
      return;
    }
    if (sourceStage === "connect") {
      setSourceStage("browse");
      return;
    }
    if (isPrefixSelection && selectedDatasetSummary?.schemaCompatible === false) {
      onNotify("Prefix 아래 데이터 파일의 스키마가 서로 호환되지 않아 다음 단계로 이동할 수 없습니다.");
      return;
    }
    if (!hasValidatedSchema) {
      onNotify("데이터를 선택하고 샘플 스키마를 확인해야 다음 단계로 이동할 수 있습니다.");
      return;
    }
    applySourceDraft(activeSourceType, verifiedSourceFields, connectionStatus, connectionMessage);
    onNext();
  };

  const sourceNextDisabled = sourceStage === "choose"
    ? !hasSelectedSource
    : sourceStage === "connect"
      ? connectionStatus !== "success"
      : isInternalDataLake
        ? !selectedCatalogDatasetId || !hasValidatedSchema
        : connectionStatus !== "success"
        || (requiresAssetSelectionForPreview && !selectedAssetPath)
        || !hasValidatedSchema;
  const canOpenSourceBrowser = isInternalDataLake
    ? hasSelectedSource && sourceStage !== "choose"
    : sourceStage === "browse" || (connectionStatus === "success" && hasDetectedAssets);

  const handleSourceStageChange = (value: string) => {
    const nextStage = value as "choose" | "connect" | "browse";
    if (nextStage === "browse" && !canOpenSourceBrowser) return;
    if (nextStage === "connect" && (!hasSelectedSource || sourceStage === "choose")) return;
    setSourceStage(nextStage);
  };

  const sourceChoiceConnectors = ["PostgreSQL", "MongoDB", "File / S3", "REST API", "Stream / Kafka", "Data Lake"];

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={sourceNextDisabled} showPrev={false} split onPrev={onPrev} onNext={goNext} />}
      className="source-creation-flow"
    >
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<Cable />}
        title="소스 연결"
      />
      <section className="panel hegun-console-panel source-connect-panel source-workbench-panel" aria-label="소스 선택 및 연결">
        <div className="source-workbench-body">
          <Tabs
            value={sourceStage}
            onValueChange={handleSourceStageChange}
          >
            <TabsList
              aria-label="소스 연결 단계"
              className="source-stage-tabs"
              style={{ gridTemplateColumns: isInternalDataLake ? "repeat(2, minmax(0, 1fr))" : undefined }}
            >
              <TabsTrigger value="choose">1. 소스 선택</TabsTrigger>
              {!isInternalDataLake && <TabsTrigger disabled={!hasSelectedSource || sourceStage === "choose"} value="connect">2. 연결 설정</TabsTrigger>}
              <TabsTrigger
                disabled={!canOpenSourceBrowser}
                value="browse"
              >
                {isInternalDataLake ? "2. 데이터셋 탐색" : "3. 데이터 탐색"}
              </TabsTrigger>
            </TabsList>

            {sourceStage === "choose" && (
              <SourceChoiceStage connectorMeta={connectorMeta} connectors={sourceChoiceConnectors} sourceType={sourceType} onSelect={selectSource} />
            )}

            {sourceStage === "connect" && hasSelectedSource && !isInternalDataLake && (
              <SourceConnectStage
                activeSourceType={activeSourceType}
                connectionStatus={connectionStatus}
                connectionStatusCopy={SOURCE_CONNECTION_STATUS_COPY}
                continuousAdvancedOpen={continuousAdvancedOpen}
                continuousConfig={continuousConfig}
                current={current}
                displayTestItems={displayTestItems}
                editableFields={editableFields}
                isSqlResultSource={isSqlResultSource}
                kafkaExecutionMode={kafkaExecutionMode}
                setContinuousAdvancedOpen={setContinuousAdvancedOpen}
                sourceLocked={sourceLocked}
                onDraftChange={onDraftChange}
                onFieldChange={updateSourceField}
                onTestConnection={testConnection}
                onUpdateContinuousConfig={updateContinuousConfig}
              />
            )}

            {sourceStage === "browse" && hasSelectedSource && (
              <ScrollArea className="h-[calc(100vh-270px)] min-h-0">
                <div className="source-stage-screen">
                  {isInternalDataLake ? (
                    <SourceExplorerWorkbench
                      explorer={(
                        <DataLakeDatasetList
                          datasets={filteredCatalogDatasets}
                          error={catalogError}
                          loading={catalogLoading}
                          selectedDatasetId={selectedCatalogDatasetId}
                          onSelect={selectCatalogDataset}
                        />
                      )}
                      explorerTitle="접근 가능한 데이터셋"
                      filterOptions={explorerConfig.filterOptions}
                      filterValue={assetFilter}
                      onFilterChange={setAssetFilter}
                      onPathChange={setAssetPathQuery}
                      onQueryChange={setAssetSearchQuery}
                      pathValue={assetPathQuery}
                      preview={(
                        <SourcePreviewDataTable
                          columnLabels={selectedCatalogDataset?.schema.map(([name]) => name) ?? []}
                          rows={selectedCatalogDataset?.sampleRows ?? []}
                        />
                      )}
                      previewTitle="데이터 미리보기"
                      queryPlaceholder="데이터셋 이름, 설명, 소유자 검색"
                      queryValue={assetSearchQuery}
                      showPathSearch={false}
                    />
                  ) : (
                    <SourceExplorerWorkbench
                      explorer={hasDetectedAssets ? (
                        <SourceAssetTree
                          assets={filteredDisplayAssets.map(([path, meta, status]) => (
                            activeSourceType === "PostgreSQL" || activeSourceType === "MongoDB"
                              ? [path, "", status]
                              : [path, meta, status]
                          ))}
                          loadingPath={loadingAssetPath}
                          selectedPath={selectedAssetPath}
                          onOpenFolder={explorerConfig.supportsPathSearch ? loadSourceAssetChildren : undefined}
                          onSelectFolder={activeSourceType === "File / S3" ? selectSourceFolder : undefined}
                          onSelect={selectSourceAsset}
                        />
                      ) : (
                        <p className="source-empty-note">연결 테스트 후 탐색 가능한 항목이 표시됩니다.</p>
                      )}
                      explorerTitle={current.assetsTitle}
                      filterOptions={explorerConfig.filterOptions}
                      filterValue={assetFilter}
                      onFilterChange={setAssetFilter}
                      onPathChange={setAssetPathQuery}
                      onPathSubmit={navigateSourceAssetPath}
                      onQueryChange={setAssetSearchQuery}
                      pathPlaceholder={explorerConfig.pathPlaceholder}
                      pathValue={assetPathQuery}
                      preview={(
                        previewShowsRawValue
                          ? <SourceRawSamplePreview
                              ariaLabel={previewShowsJson ? "Kafka JSON 원본 샘플" : "원본 로그 샘플"}
                              lines={rawTextPreviewLines}
                            />
                          : (
                            <SourcePreviewDataTable
                              columnLabels={displayPreviewColumns.map(sourceColumnLabel)}
                              rows={displayPreviewRows}
                            />
                          )
                      )}
                      previewIcon={previewShowsJson ? <Braces /> : previewShowsRawText ? <FileText /> : undefined}
                      previewMeta={previewShowsRawText && activeSourceType === "Stream / Kafka" ? undefined : (
                        <Badge variant="outline" className="border-blue-200 bg-white text-blue-700">{displayPreviewFormat}</Badge>
                      )}
                      previewTitle={previewShowsRawValue
                        ? (previewShowsJson ? "Kafka JSON 원본 샘플" : activeSourceType === "Stream / Kafka" ? "Kafka raw text 원본 샘플" : "원본 샘플")
                        : selectedDatasetSummary
                          ? `대표 파일 · ${selectedDatasetSummary.representativeObject}`
                          : selectedAsset?.[0] || sourcePreviewTitle}
                      queryPlaceholder={explorerConfig.queryPlaceholder}
                      queryValue={assetSearchQuery}
                      showPathSearch={explorerConfig.supportsPathSearch}
                    />
                  )}
                </div>
              </ScrollArea>
            )}
          </Tabs>
        </div>
      </section>
    </CreationFlowLayout>
  );
}
