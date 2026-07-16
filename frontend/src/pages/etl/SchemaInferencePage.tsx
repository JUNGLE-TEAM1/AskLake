import { Button } from "@/components/ui/button";
import { CommandBar } from "@/components/ui/command-bar";
import {
  Check,
  Database,
  RefreshCw,
  Table2
} from "lucide-react";
import { useState } from "react";
import { testSourceConnector } from "../../services/sourceConnectorService";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, SchemaColumnDraft } from "../../types";
import { SchemaResultPreview } from "./SchemaResultPreview";
import { SchemaRuleSummary } from "./SchemaRuleSummary";
import { SchemaTransformWorkbench } from "./SchemaTransformWorkbench";

import {
  buildSchemaFingerprint,
  buildSourceShapePreview,
  cloneSchemaColumns,
  cloneSchemaRows,
  compactSchemaByPathDepth,
  detectSchemaSourceFormat,
  estimateNullRatio,
  isSchemaColumnIncluded,
  sampleValuesForColumn,
  SchemaBaseSnapshot,
  schemaFlowWindow,
  SchemaSampleScope,
  schemaSampleScopeOptionsForSource,
  summarizeSchemaColumns,
  upsertConfigValue,
  valueDistribution,
  withUniqueTargetNames
} from "./schemaModel";
import {
  mergeConnectorAnalysisSourceConfig,
  publicConnectorAnalysis,
  publicSchemaSummary
} from "./sourceModel";

export function SchemaInferencePage({
  draft,
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const [schemaFilter, setSchemaFilter] = useState("");
  const [selectedSchemaIndex, setSelectedSchemaIndex] = useState(0);
  const [flattenObjects, setFlattenObjects] = useState(true);
  const [flattenDepth, setFlattenDepth] = useState(2);
  const [flattenBaseSchema, setFlattenBaseSchema] = useState<SchemaBaseSnapshot | null>(null);
  const [schemaSampleScope, setSchemaSampleScope] = useState<SchemaSampleScope>("current");
  const [isRecheckingSchema, setIsRecheckingSchema] = useState(false);
  const [showResultPreview, setShowResultPreview] = useState(false);
  const hasInferredSchema = draft.schema.columns.length > 0;
  const schemaColumns: SchemaColumnDraft[] = draft.schema.columns;
  const includedSchemaColumns = schemaColumns.filter(isSchemaColumnIncluded);
  const includedSchemaColumnItems = schemaColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => isSchemaColumnIncluded(column));
  const schemaSampleRows = draft.schema.sampleRows;
  const lowConfidenceCount = includedSchemaColumns.filter((column) => (column.confidence ?? 100) < 80).length;
  const averageConfidence = schemaColumns.length
    ? Math.round(schemaColumns.reduce((sum, column) => sum + (column.confidence ?? 70), 0) / schemaColumns.length)
    : 0;
  const sourceFormat = detectSchemaSourceFormat(draft);
  const isFlattenedJson = schemaColumns.some((column) => column.sourceName.includes(".")) || ["JSON", "JSONL"].includes(sourceFormat);
  const nestedFieldCount = schemaColumns.filter((column) => column.sourceName.includes(".")).length;
  const mappingModeText = hasInferredSchema
    ? isFlattenedJson
      ? flattenObjects
        ? `${sourceFormat} 원본 필드를 최대 ${flattenDepth}단계까지 출력 컬럼으로 평탄화`
        : `${sourceFormat} 중첩 객체를 JSON 컬럼으로 유지`
      : `${sourceFormat} 원본 컬럼을 출력 테이블 컬럼으로 매핑`
    : "소스 연결 후 원본 필드와 출력 컬럼 매핑을 확인할 수 있습니다.";
  const previewRow = schemaSampleRows[0] ?? [];
  const sourcePreviewText = buildSourceShapePreview(schemaColumns, previewRow);
  const inferredSummary = hasInferredSchema ? publicSchemaSummary(draft.schema.summary) : "스키마 추론 전에 소스 연결이 필요합니다.";
  const approvedSummary = summarizeSchemaColumns(schemaColumns, lowConfidenceCount, sourceFormat);
  const sampleScopeOptions = schemaSampleScopeOptionsForSource(draft.source.sourceType);
  const selectedSampleScopeLabel = sampleScopeOptions.find((option) => option.value === schemaSampleScope)?.label ?? sampleScopeOptions[0].label;
  const schemaFingerprint = buildSchemaFingerprint(schemaColumns);
  const selectedIndex = schemaColumns.length ? Math.min(selectedSchemaIndex, schemaColumns.length - 1) : 0;
  const selectedColumn = schemaColumns[selectedIndex];
  const selectedSampleValues = selectedColumn ? sampleValuesForColumn(schemaSampleRows, selectedIndex) : [];
  const selectedNullRatio = selectedColumn ? estimateNullRatio(schemaSampleRows, selectedIndex) : 0;
  const selectedDistribution = selectedColumn ? valueDistribution(selectedSampleValues) : [];
  const schemaFlowItems = schemaFlowWindow(schemaColumns, schemaSampleRows, selectedIndex);
  const selectedFlowItem = schemaFlowItems.find((item) => item.index === selectedIndex) ?? schemaFlowItems[0];
  const previewOutputItems = includedSchemaColumnItems.slice(0, 8);
  const hiddenPreviewColumnCount = Math.max(0, includedSchemaColumnItems.length - previewOutputItems.length);
  const previewOutputRows = schemaSampleRows.slice(0, 4);
  const visibleSchemaColumns = schemaColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => {
      const keyword = schemaFilter.trim().toLowerCase();
      if (!keyword) return true;
      return `${column.sourceName} ${column.targetName} ${column.type} ${column.role ?? ""}`.toLowerCase().includes(keyword);
    });

  const applySchemaDraft = (summary: string, columns = schemaColumns, sampleRows = schemaSampleRows) => {
    if (columns.length === 0) return false;
    onDraftChange({
      schema: {
        columns,
        sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary,
      },
    });
    return true;
  };

  const patchSchemaColumns = (columns: SchemaColumnDraft[], sampleRows = schemaSampleRows) => {
    const reviewCount = columns.filter((column) => (column.confidence ?? 100) < 80).length;
    onDraftChange({
      schema: {
        columns,
        sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary: columns.length > 0 ? summarizeSchemaColumns(columns, reviewCount, sourceFormat) : "출력 컬럼 없음 · 스키마 매핑 필요",
      },
    });
  };

  const currentSourceLabel = draft.source.sourceLabel || draft.source.sourceType || "source";

  const getFlattenBaseSchema = () => {
    if (flattenBaseSchema?.sourceLabel === currentSourceLabel && flattenBaseSchema.columns.length > 0) {
      return flattenBaseSchema;
    }
    const base = {
      columns: cloneSchemaColumns(schemaColumns),
      sampleRows: cloneSchemaRows(schemaSampleRows),
      sourceLabel: currentSourceLabel,
    };
    setFlattenBaseSchema(base);
    return base;
  };

  const applyFlattenSettings = (nextFlattenObjects: boolean, nextDepth = flattenDepth) => {
    if (!hasInferredSchema) {
      onNotify("변경할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    const base = getFlattenBaseSchema();
    const maxPathSegments = nextFlattenObjects ? nextDepth : 1;
    const nextSchema = compactSchemaByPathDepth(base.columns, base.sampleRows, maxPathSegments);
    setFlattenObjects(nextFlattenObjects);
    setFlattenDepth(nextDepth);
    patchSchemaColumns(nextSchema.columns, nextSchema.sampleRows);
    setSelectedSchemaIndex(0);
    onAction(
      nextFlattenObjects ? "etl.schema.flatten_enabled" : "etl.schema.flatten_disabled",
      "/api/etl/schema-inference/flattening",
      draft.source.sourceLabel || "schema",
    );
    onNotify(nextFlattenObjects
      ? `중첩 객체를 최대 ${nextDepth}단계까지 출력 컬럼으로 펼쳤습니다.`
      : "중첩 객체를 JSON 컬럼으로 유지합니다.");
  };

  const selectSampleScope = (scope: SchemaSampleScope) => {
    const option = sampleScopeOptions.find((item) => item.value === scope) ?? sampleScopeOptions[0];
    setSchemaSampleScope(scope);
    onDraftChange({
      source: {
        sourceConfig: upsertConfigValue(
          upsertConfigValue(draft.source.sourceConfig, "__Schema Sample Scope", option.value),
          "__Schema Sample Scope Label",
          option.label,
        ),
      },
    });
    onAction("etl.schema.sample_scope_changed", "/api/etl/schema-inference/sample-scope", option.label);
    onNotify(`${option.label} 기준으로 스키마 확인 범위를 설정했습니다.`);
  };

  const updateSchemaColumn = (index: number, patch: Partial<SchemaColumnDraft>) => {
    const nextColumns = schemaColumns.map((column, columnIndex) => (
      columnIndex === index ? { ...column, ...patch } : column
    ));
    patchSchemaColumns(nextColumns);
  };

  const deleteSchemaColumn = (index: number) => {
    const nextColumns = schemaColumns.filter((_, columnIndex) => columnIndex !== index);
    const nextSampleRows = schemaSampleRows.map((row) => row.filter((_, cellIndex) => cellIndex !== index));
    patchSchemaColumns(nextColumns, nextSampleRows);
    setSelectedSchemaIndex(Math.max(0, Math.min(index, nextColumns.length - 1)));
    onAction("etl.schema.column_deleted", "/api/etl/schema-inference/columns", schemaColumns[index]?.sourceName ?? "schema");
    onNotify(nextColumns.length > 0 ? "출력 컬럼에서 제외했습니다." : "모든 출력 컬럼이 제외됐습니다. 최소 1개 컬럼을 남겨야 생성할 수 있습니다.");
  };

  const resetSchemaMappings = () => {
    const nextColumns = withUniqueTargetNames(schemaColumns);
    patchSchemaColumns(nextColumns);
    onAction("etl.schema.mappings_reset", "/api/etl/schema-inference/reset-mappings", draft.source.sourceLabel || "source");
    onNotify("원본 필드 기준으로 출력 컬럼명을 다시 맞췄습니다.");
  };

  const schemaAction = (action: string, path: string, schemaSummary?: string) => {
    onAction(action, path, draft.source.sourceLabel || "source");
    if (schemaSummary) {
      applySchemaDraft(schemaSummary);
    }
  };

  const approveSchema = () => {
    if (!hasInferredSchema) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("확정할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return false;
    }
    if (includedSchemaColumns.length === 0) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", draft.source.sourceLabel || "source", "failed");
      onNotify("출력에 포함된 컬럼이 없습니다. 최소 1개 컬럼을 포함해야 실행할 수 있습니다.");
      return false;
    }
    const emptyNameColumn = includedSchemaColumns.find((column) => !column.targetName.trim());
    if (emptyNameColumn) {
      onAction("etl.schema.confirm_blocked", "/api/etl/schema-inference/confirm", emptyNameColumn.sourceName, "failed");
      onNotify(`${emptyNameColumn.sourceName} 필드의 출력 이름을 입력해야 합니다.`);
      return false;
    }
    schemaAction("etl.schema.confirmed", "/api/etl/schema-inference/confirm", approvedSummary);
    return true;
  };

  const saveSchemaDraft = () => {
    if (!applySchemaDraft(approvedSummary)) {
      onNotify("저장할 스키마가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    onSave();
  };

  const confirmCurrentSchema = () => {
    if (!approveSchema()) return;
    onNext();
  };

  const applySelectedField = () => {
    if (!selectedColumn) {
      onNotify("적용할 필드가 없습니다.");
      return;
    }
    onAction("etl.schema.field_applied", "/api/etl/schema-inference/field", selectedColumn.sourceName);
    onNotify(`${selectedColumn.targetName || selectedColumn.sourceName} 필드 변경사항을 적용했습니다.`);
  };

  const rerunCurrentInference = async () => {
    if (draft.source.sourceType === "SQL Result") {
      onAction("etl.schema.inference_skipped", "/api/query/runs", draft.source.sourceLabel || "SQL Result");
      onNotify("SQL Preview에서 전달된 schema를 사용하므로 재확인을 생략합니다.");
      return;
    }

    if (!draft.source.sourceType || draft.source.sourceConfig.length === 0) {
      onNotify("다시 확인할 소스 연결 정보가 없습니다. 소스 연결 테스트를 먼저 실행하세요.");
      return;
    }
    setIsRecheckingSchema(true);
    const sourceConfig = upsertConfigValue(
      upsertConfigValue(draft.source.sourceConfig, "__Schema Sample Scope", schemaSampleScope),
      "__Schema Sample Scope Label",
      selectedSampleScopeLabel,
    );
    try {
      const result = mergeConnectorAnalysisSourceConfig(
        publicConnectorAnalysis(await testSourceConnector(draft.source.sourceType, sourceConfig)),
        sourceConfig,
      );
      onDraftChange(result.draftPatch);
      setFlattenBaseSchema(null);
      setSelectedSchemaIndex(0);
      onAction("etl.schema.inference_checked", "/api/etl/schema-inference", draft.source.sourceLabel || "source", result.status === "failed" ? "failed" : "success");
      onNotify(`${selectedSampleScopeLabel} 기준으로 스키마를 다시 확인했습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "스키마 재확인 중 오류가 발생했습니다.";
      onAction("etl.schema.inference_failed", "/api/etl/schema-inference", draft.source.sourceLabel || "source", "failed");
      onNotify(message);
    } finally {
      setIsRecheckingSchema(false);
    }
  };

  return (
    <div className="schema-workbench schema-workbench-focused">
      <section className="schema-status-strip">
        <div className="schema-status-item source">
          <Database size={17} />
          <span>데이터 소스</span>
          <strong>{draft.source.sourceLabel || "-"}</strong>
        </div>
        <div className="schema-status-item">
          <span>샘플 행</span>
          <strong>{schemaSampleRows.length.toLocaleString()}</strong>
        </div>
        <div className={lowConfidenceCount > 0 ? "schema-status-item warning" : "schema-status-item success"}>
          <span>상태</span>
          <strong>{hasInferredSchema ? (lowConfidenceCount > 0 ? "검토 필요" : "추론 완료") : "소스 연결 필요"}</strong>
        </div>
        <div className="schema-status-actions">
          <Button className="secondary-button" type="button" variant="outline" disabled={!hasInferredSchema} onClick={resetSchemaMappings}>
            <RefreshCw size={15} /> 매핑 초기화
          </Button>
          <Button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", approvedSummary)}>
            <Check size={15} /> 스키마 승인
          </Button>
        </div>
      </section>

      <CommandBar className="schema-bottom-bar schema-top-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>이전</Button>
        <span>2/3 단계 · {hasInferredSchema ? approvedSummary : inferredSummary}</span>
        <Button
          aria-expanded={showResultPreview}
          className="secondary-button schema-result-preview-button"
          type="button"
          variant="outline"
          disabled={!hasInferredSchema}
          onClick={() => setShowResultPreview((current) => !current)}
        >
          <Table2 size={15} /> {showResultPreview ? "미리보기 닫기" : "결과 미리보기"}
        </Button>
        <Button className="primary-button" type="button" disabled={!hasInferredSchema} onClick={confirmCurrentSchema}>다음</Button>
        <Button className="ghost-button" type="button" variant="ghost" onClick={saveSchemaDraft}>설정 저장</Button>
      </CommandBar>

      <div className="schema-workbench-content">
        <SchemaTransformWorkbench
          columns={schemaColumns}
          executionMode={draft.source.executionMode}
          sampleRows={schemaSampleRows}
          selectedIndex={selectedIndex}
          sourceFormat={sourceFormat}
          sourceType={draft.source.sourceType}
          qualityRules={draft.quality.rules}
          transformSteps={draft.transform.steps}
          onSelectedIndexChange={setSelectedSchemaIndex}
          onColumnsChange={(nextColumns, nextSampleRows = schemaSampleRows) => {
            patchSchemaColumns(nextColumns, nextSampleRows);
            const boundedIndex = nextColumns.length > 0 ? Math.min(selectedIndex, nextColumns.length - 1) : 0;
            setSelectedSchemaIndex(boundedIndex);
          }}
          onTransformStepsChange={(steps, outputColumns) => {
            onDraftChange({
              transform: {
                outputColumns,
                steps,
                summary: steps.length > 0 ? `스키마 단계 변환 ${steps.length}개 설정` : "스키마 단계 변환 없음",
              },
            });
          }}
          onQualityRulesChange={(rules) => {
            onDraftChange({
              quality: {
                invalidRows: [],
                rules,
                score: undefined,
                status: "idle",
                summary: rules.length > 0 ? `스키마 단계 품질 규칙 ${rules.length}개 설정` : "데이터 품질 규칙 없음",
              },
            });
          }}
        />

        {showResultPreview ? (
          <SchemaResultPreview
            columns={schemaColumns}
            qualityRules={draft.quality.rules}
            sampleRows={schemaSampleRows}
          />
        ) : null}

        <SchemaRuleSummary
          columns={schemaColumns}
          qualityRules={draft.quality.rules}
          transformSteps={draft.transform.steps}
        />
      </div>

    </div>
  );
}
