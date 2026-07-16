import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { TagList } from "@/components/ui/tag-list";
import { cn } from "@/lib/utils";
import {
  FileText,
  HardDrive,
  Plus,
  SlidersHorizontal
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { S3PathField } from "../../components/s3/S3PathField";
import { listS3Buckets } from "../../services/s3PathApi";
import type { DraftPipeline, DraftPipelinePatch } from "../../types";

import {
  SPARK_OUTPUT_BUCKET
} from "./sourceModel";
import {
  buildJobName,
  buildTargetStoragePath,
  buildTargetStoragePathForBucket,
  DraftPipelineWithSlices,
  formatPartitionColumnType,
  getTargetDraftValues,
  inferTargetSchema,
  isManagedTargetStoragePath,
  KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS,
  KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS,
  KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS,
  normalizeTargetFileFormat,
  TARGET_CONFIG_STORAGE_KEY,
  TARGET_FORMAT_OPTIONS,
  TARGET_LAYER_OPTIONS,
  TargetSavedConfig,
  TargetSchemaRule,
  TargetTestRun,
  validateTargetConfig
} from "./targetModel";

export function TargetPage({
  draft,
  onDraftChange,
  onPrev,
  onNext,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialTarget = getTargetDraftValues(draft);
  const draftTarget = (draft as DraftPipelineWithSlices).target;
  const isKafkaSource = draft.source.sourceType === "Stream / Kafka" || draft.source.sourceType === "Kafka JSON";
  const isKafkaContinuous = isKafkaSource && draft.source.executionMode === "continuous";
  const isKafkaSnapshot = isKafkaSource && !isKafkaContinuous;
  const targetLayerOptions = isKafkaSnapshot ? KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS : TARGET_LAYER_OPTIONS;
  const targetFormatOptions = isKafkaContinuous
    ? KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS
    : isKafkaSnapshot
      ? KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS
      : TARGET_FORMAT_OPTIONS.filter((format) => format !== "jsonl");
  const initialTargetLayer = targetLayerOptions.includes(initialTarget.targetLayer)
    ? initialTarget.targetLayer
    : targetLayerOptions[0] ?? "BRONZE";
  const normalizedInitialTargetFormat = normalizeTargetFileFormat(initialTarget.targetFormat);
  const initialTargetFormat = targetFormatOptions.includes(normalizedInitialTargetFormat)
    ? normalizedInitialTargetFormat
    : targetFormatOptions[0] ?? "parquet";
  const initialStoragePath = initialTargetLayer !== initialTarget.targetLayer
    && initialTarget.storagePath === buildTargetStoragePath(initialTarget.targetDataset, initialTarget.targetLayer)
    ? buildTargetStoragePath(initialTarget.targetDataset, initialTargetLayer)
    : initialTarget.storagePath;
  const inferredTarget = useMemo(
    () => inferTargetSchema(draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules),
    [draft.schema.columns, draft.schema.sampleRows, draftTarget?.schemaRules],
  );
  const sampleTargetSchema = useMemo(() => inferTargetSchema([], [], undefined), []);
  const [targetDataset, setTargetDataset] = useState(initialTarget.targetDataset);
  const databaseName = draftTarget?.databaseName ?? "asklake";
  const targetLayer = initialTargetLayer;
  const [runtimeOutputBucket, setRuntimeOutputBucket] = useState(SPARK_OUTPUT_BUCKET);
  const [targetStoragePath, setTargetStoragePath] = useState(initialStoragePath);
  const [storagePathCustomized, setStoragePathCustomized] = useState(
    !isManagedTargetStoragePath(initialStoragePath, initialTarget.targetDataset, initialTargetLayer),
  );
  const [targetDescription, setTargetDescription] = useState(initialTarget.description);
  const [targetFormat, setTargetFormat] = useState(initialTargetFormat);
  const targetOwner = draftTarget?.owner ?? initialTarget.owner;
  const [targetManager, setTargetManager] = useState(draftTarget?.manager ?? initialTarget.owner);
  const [targetTags, setTargetTags] = useState<string[]>(initialTarget.tags);
  const [customTag, setCustomTag] = useState("");
  const [partitionColumns, setPartitionColumns] = useState<string[]>(draftTarget?.partitionColumns ?? initialTarget.partitionColumns);
  const [indexColumns] = useState<string[]>(draftTarget?.indexColumns ?? []);
  const [schemaRules, setSchemaRules] = useState<TargetSchemaRule[]>(inferredTarget.schemaRules);
  const lastTestRun = draftTarget?.lastTestRun ?? { status: "idle", logs: [] };
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void listS3Buckets()
      .then(({ buckets }) => {
        const outputBucket = buckets[0]?.trim();
        if (active && outputBucket) setRuntimeOutputBucket(outputBucket);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (storagePathCustomized) return;
    setTargetStoragePath(buildTargetStoragePathForBucket(
      runtimeOutputBucket,
      targetDataset.trim() || "target_dataset",
      targetLayer,
    ));
  }, [runtimeOutputBucket, storagePathCustomized, targetDataset, targetLayer]);

  const shouldUseSampleTargetSchema = useMemo(
    () => !schemaRules.some((rule) => rule.partitionable && !rule.raw),
    [schemaRules],
  );
  const activeSchemaRules = shouldUseSampleTargetSchema ? sampleTargetSchema.schemaRules : schemaRules;
  const activePreviewRows = shouldUseSampleTargetSchema ? sampleTargetSchema.previewRows : inferredTarget.previewRows;
  const activeJsonParseFailed = shouldUseSampleTargetSchema ? sampleTargetSchema.jsonParseFailed : inferredTarget.jsonParseFailed;
  const orderedSchemaRules = useMemo(() => [...activeSchemaRules], [activeSchemaRules]);
  const usedSchemaRules = useMemo(() => orderedSchemaRules.filter((rule) => rule.use), [orderedSchemaRules]);
  const partitionCandidates = useMemo(() => orderedSchemaRules.filter((rule) => rule.partitionable && !rule.raw), [orderedSchemaRules]);
  const filteredPartitionColumns = partitionColumns
    .filter((column) => partitionCandidates.some((rule) => rule.name === column && rule.use));
  const previewRows = useMemo(() => activePreviewRows.slice(0, 5).map((row) => {
    const previewRow: Record<string, string> = {};
    usedSchemaRules.forEach((rule) => {
      previewRow[rule.name] = row[rule.name] ?? "";
    });
    return previewRow;
  }), [activePreviewRows, usedSchemaRules]);
  const lineage = {
    sourceName: draft.source.sourceLabel || "Source",
    targetDatasetName: targetDataset || "Target",
    targetStoragePath,
    transformStepCount: draft.transform.steps.length,
  };
  const targetTableName = targetDataset.trim();
  const buildConfig = (testRun: TargetTestRun = lastTestRun): TargetSavedConfig => ({
    metadata: {
      databaseName,
      datasetName: targetDataset,
      description: targetDescription,
      fileFormat: targetFormat,
      manager: targetManager,
      owner: targetOwner,
      storagePath: targetStoragePath,
      targetTableName,
    },
    tags: targetTags,
    partitionColumns: filteredPartitionColumns,
    indexColumns,
    schemaRules: activeSchemaRules,
    previewRows,
    lineage,
    lastTestRun: testRun,
  });

  const persistDraft = (config: TargetSavedConfig) => {
    onDraftChange({
      jobName: buildJobName(config.metadata.datasetName),
      compression: "Snappy",
      partition: config.partitionColumns.join("/"),
      storagePath: config.metadata.storagePath,
      storageType: "S3",
      target: {
        databaseName: config.metadata.databaseName,
        datasetName: config.metadata.datasetName,
        description: config.metadata.description,
        format: config.metadata.fileFormat,
        indexColumns: config.indexColumns,
        lastTestRun: config.lastTestRun,
        manager: config.metadata.manager,
        owner: config.metadata.owner,
        partitionColumns: config.partitionColumns,
        rag: false,
        schemaRules: config.schemaRules,
        storagePath: config.metadata.storagePath,
        tableName: config.metadata.targetTableName,
        targetTableName: config.metadata.targetTableName,
        tags: config.tags,
        testStatus: config.lastTestRun.status === "success" ? "success" : config.lastTestRun.status === "failed" ? "failed" : "idle",
      },
      targetDataset: config.metadata.datasetName,
      targetFormat: config.metadata.fileFormat,
      targetLayer,
      rag: false,
    });
  };

  const updateSchemaRule = (sourceName: string, patch: Partial<TargetSchemaRule>) => {
    setSchemaRules((currentRules) => {
      const nextRules = currentRules.map((rule) => {
        if (rule.sourceName !== sourceName) return rule;
        const nextRule = { ...rule, ...patch };
        if (patch.type) {
          nextRule.partitionable = !nextRule.raw && patch.type !== "json";
        }
        return nextRule;
      });
      return nextRules;
    });
  };

  const toggleTag = (tag: string) => {
    setTargetTags((currentTags) => currentTags.includes(tag)
      ? currentTags.filter((currentTag) => currentTag !== tag)
      : [...currentTags, tag]);
  };

  const addCustomTag = () => {
    const nextTag = customTag.trim();
    if (!nextTag) return;
    setTargetTags((currentTags) => currentTags.includes(nextTag) ? currentTags : [...currentTags, nextTag]);
    setCustomTag("");
  };

  const setPartitionColumnSelected = (columnName: string, selected: boolean) => {
    setPartitionColumns((currentColumns) => selected
      ? currentColumns.includes(columnName) ? currentColumns : [...currentColumns, columnName]
      : currentColumns.filter((column) => column !== columnName));
  };

  const changeTargetDataset = (nextDataset: string) => {
    setTargetDataset(nextDataset);
    if (!storagePathCustomized) {
      setTargetStoragePath(buildTargetStoragePathForBucket(
        runtimeOutputBucket,
        nextDataset.trim() || "target_dataset",
        targetLayer,
      ));
    }
  };

  const saveTargetConfig = () => {
    const config = buildConfig();
    const errors = validateTargetConfig(config, activeJsonParseFailed);
    if (!targetLayerOptions.includes(targetLayer)) errors.push(`현재 실행 방식에서 ${targetLayer} 레이어를 사용할 수 없습니다.`);
    if (!targetFormatOptions.includes(targetFormat)) errors.push(`현재 실행 방식에서 ${targetFormat.toUpperCase()} 포맷을 사용할 수 없습니다.`);
    setValidationErrors(errors);

    if (errors.length > 0) {
      return false;
    }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(TARGET_CONFIG_STORAGE_KEY, JSON.stringify(config, null, 2));
    }
    persistDraft(config);
    return true;
  };

  const handleNext = () => {
    if (!saveTargetConfig()) return;
    onNext();
  };
  const targetNextDisabled = validateTargetConfig(buildConfig(), activeJsonParseFailed).length > 0
    || !targetLayerOptions.includes(targetLayer)
    || !targetFormatOptions.includes(targetFormat);

  const renderPartitionOption = (rule: TargetSchemaRule) => {
    const selected = filteredPartitionColumns.includes(rule.name);
    const disabled = !rule.use;
    const checkboxId = `target-partition-${rule.name}`;
    return (
      <label
        className={cn("target-partition-option", selected && "active", disabled && "disabled")}
        key={rule.name}
      >
        <Checkbox
          checked={selected}
          disabled={disabled}
          id={checkboxId}
          onCheckedChange={(checked) => setPartitionColumnSelected(rule.name, checked === true)}
        />
        <span className="target-partition-name">{rule.name}</span>
        <span className="target-partition-type">{formatPartitionColumnType(rule)}</span>
      </label>
    );
  };

  return (
    <CreationFlowLayout className="target-page-layout" actions={<CreationTopActions nextDisabled={targetNextDisabled} prevLabel="이전" nextLabel="다음" split onPrev={onPrev} onNext={handleNext} />}>
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<HardDrive />}
        title="타겟 설정"
      />
      {validationErrors.length > 0 ? (
        <div className="target-validation-summary" role="alert">
          {validationErrors.map((error) => <span key={error}>{error}</span>)}
        </div>
      ) : null}
      <div className="etl-review-stack target-config-stack">
        <section className="etl-review-card target-config-card">
          <EtlSectionHeader icon={<FileText />} title="기본 정보" />
          <div className="target-config-form-grid basic">
            <FormFieldGroup className="field" label="출력 데이터셋 이름">
              <Input className="input control-input" value={targetDataset} onChange={(event) => changeTargetDataset(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field" label="설명">
              <Input className="input control-input" value={targetDescription} onChange={(event) => setTargetDescription(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field target-manager-field" label="담당자">
              <Input className="input control-input" value={targetManager} onChange={(event) => setTargetManager(event.target.value)} />
            </FormFieldGroup>
            <FormFieldGroup className="field wide target-tags-field" label="태그">
              {targetTags.length > 0 ? (
                <TagList className="target-chip-grid" density="compact" role="group" aria-label="타겟 태그">
                  {targetTags.map((tag) => (
                    <Button aria-pressed={targetTags.includes(tag)} key={tag} size="sm" type="button" variant="secondary" onClick={() => toggleTag(tag)}>
                      {tag}
                    </Button>
                  ))}
                </TagList>
              ) : null}
              <div className="target-inline-controls">
                <Input className="input control-input" placeholder="태그 입력" value={customTag} onChange={(event) => setCustomTag(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomTag();
                  }
                }} />
                <Button type="button" variant="outline" onClick={addCustomTag}><Plus data-icon="inline-start" />추가</Button>
              </div>
            </FormFieldGroup>
          </div>
        </section>

        <section className="etl-review-card target-config-card">
          <EtlSectionHeader icon={<HardDrive />} title="저장 위치 설정" />
          <div className="target-config-form-grid destination">
            <FormFieldGroup className="field target-format-field" label="파일 형식">
              <Select value={targetFormat} onValueChange={(value) => setTargetFormat(normalizeTargetFileFormat(value))}>
                <SelectTrigger className="input control-input" aria-label="파일 형식">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targetFormatOptions.map((format) => <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormFieldGroup>
            <FormFieldGroup className="field wide target-storage-field" label="저장 경로">
              <S3PathField useShadcnStyles value={targetStoragePath} onChange={(path) => {
                setTargetStoragePath(path);
                setStoragePathCustomized(true);
              }} />
            </FormFieldGroup>
          </div>
        </section>
        <section className="etl-review-card target-config-card">
          <EtlSectionHeader icon={<SlidersHorizontal />} title="파티션 설정" />
          <div className="target-partition-settings">
            <div className="target-partition-table">
              <div className="target-partition-header" aria-hidden="true">
                <span>선택</span>
                <span>컬럼명</span>
                <span>데이터 타입</span>
              </div>
              <div className="target-partition-grid" role="group" aria-label="파티션 컬럼 다중 선택">
                {partitionCandidates.map(renderPartitionOption)}
              </div>
            </div>
          </div>
        </section>
      </div>
    </CreationFlowLayout>
  );
}
