import { Button } from "@/components/ui/button";
import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Check,
  FileText,
  Info,
  SlidersHorizontal,
  Sparkles,
  Table2
} from "lucide-react";
import { useEffect, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { previewRecordParsing } from "../../services/sourceConnectorService";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, RecordParsingDraft, RecordParsingPreviewResponse, SchemaColumnDraft } from "../../types";
import { applyClickEventRecordSchemaPreset, CLICK_EVENT_RECORD_SCHEMA_PRESET, isClickEventLogSource } from "./recordParsingPreset";

import {
  buildSchemaFingerprint,
  normalizeTargetColumnName,
  schemaTypeOptions
} from "./schemaModel";

export function RecordParsingPage({
  draft,
  onAction,
  onDraftChange,
  onNext,
  onNotify,
  onPrev,
}: {
  draft: DraftPipeline;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNext: () => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
}) {
  const rawLines = draft.source.rawPreviewLines ?? [];
  const [preview, setPreview] = useState<RecordParsingPreviewResponse | null>(null);
  const [parsing, setParsing] = useState<RecordParsingDraft>(draft.recordParsing);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const hasClickEventPreset = isClickEventLogSource(draft.source.sourceLabel, draft.source.sourceConfig);

  const loadPreview = async (nextParsing: RecordParsingDraft) => {
    setLoading(true);
    setError("");
    try {
      const result = await previewRecordParsing(rawLines, nextParsing);
      setPreview(result);
      setParsing(result.recordParsing);
      onAction("etl.record_parsing.previewed", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt");
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "레코드 구조화 미리보기에 실패했습니다.";
      setError(message);
      onAction("etl.record_parsing.preview_failed", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt", "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (rawLines.length === 0) {
      setError("원본 TXT 샘플이 없습니다. 소스 단계에서 파일을 다시 선택해 주세요.");
      return;
    }
    void loadPreview(draft.recordParsing.enabled ? draft.recordParsing : {
      columns: [],
      delimiterKind: "whitespace",
      delimiterPattern: "\\s+",
      enabled: true,
      expectedFieldCount: 0,
      header: false,
    });
  }, [draft.source.sourceLabel]);

  const updateHeader = (header: boolean) => {
    const next = { ...parsing, columns: [], expectedFieldCount: 0, header };
    setParsing(next);
    void loadPreview(next);
  };

  const updateColumn = (position: number, patch: Partial<RecordParsingDraft["columns"][number]>) => {
    const columns = parsing.columns.map((column) => column.position === position ? { ...column, ...patch } : column);
    const nextParsing = { ...parsing, columns };
    setParsing(nextParsing);
    setPreview((current) => current ? {
      ...current,
      columns: current.columns.map((column, index) => index === position ? {
        ...column,
        sourceName: patch.name ?? column.sourceName,
        targetName: patch.name ?? column.targetName,
        type: patch.inferredType ?? column.type,
      } : column),
      recordParsing: nextParsing,
    } : current);
  };

  const applyRecommendedSchema = () => {
    const nextParsing = applyClickEventRecordSchemaPreset(parsing);
    if (!nextParsing) {
      onNotify("10개 필드가 감지된 클릭 이벤트 로그에서만 추천 스키마를 적용할 수 있습니다.");
      return;
    }

    setParsing(nextParsing);
    setPreview((current) => current ? {
      ...current,
      columns: current.columns.map((column, index) => ({
        ...column,
        sourceName: nextParsing.columns[index].name,
        targetName: nextParsing.columns[index].name,
        type: nextParsing.columns[index].inferredType,
      })),
      recordParsing: nextParsing,
    } : current);
    onAction("etl.record_parsing.recommended_schema_applied", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "click-events.log");
    onNotify("추천 스키마 10개 필드를 적용했습니다.");
  };

  const normalizedNames = parsing.columns.map((column) => normalizeTargetColumnName(column.name));
  const columnNamesValid = normalizedNames.every(Boolean) && new Set(normalizedNames).size === normalizedNames.length;
  const canApply = Boolean(preview?.canApply && columnNamesValid && parsing.columns.length === parsing.expectedFieldCount);

  const applyAndContinue = () => {
    if (!preview || !canApply) {
      onNotify("필드 개수와 컬럼명을 확인한 뒤 다시 시도해 주세요.");
      return;
    }
    const columns = parsing.columns.map((column) => {
      const name = normalizeTargetColumnName(column.name) || `field_${column.position + 1}`;
      return {
        confidence: 90,
        included: false,
        nullable: false,
        sourceName: name,
        targetName: name,
        type: column.inferredType,
      } satisfies SchemaColumnDraft;
    });
    const normalizedParsing: RecordParsingDraft = {
      ...parsing,
      columns: parsing.columns.map((column) => ({ ...column, name: normalizeTargetColumnName(column.name) })),
      enabled: true,
    };
    onDraftChange({
      recordParsing: normalizedParsing,
      schema: {
        columns,
        sampleRows: preview.sampleRows,
        schemaFingerprint: buildSchemaFingerprint(columns),
        summary: `TXT 연속 공백 구조화 · ${preview.totalRows}행 검증 · ${columns.length}개 필드`,
      },
      transform: {
        outputColumns: columns.map((column) => [column.targetName, column.type]),
        summary: "레코드 구조화 적용 · 추가 변환 없음",
      },
    });
    onAction("etl.record_parsing.applied", "/api/etl/record-parsing/preview", draft.source.sourceLabel || "txt");
    onNext();
  };

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={!canApply || loading} useShadcnStyles onPrev={onPrev} onNext={applyAndContinue} />}
    >
      <header className="record-parsing-page-header">
        <span className="record-parsing-page-icon" aria-hidden="true"><SlidersHorizontal /></span>
        <h2>레코드 구조화</h2>
      </header>

      <div className="record-parsing-workspace">
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><FileText aria-hidden="true" />원본 샘플</h2>
          </div>
          <div className="record-parsing-panel-body">
            <textarea className="input record-parsing-raw" readOnly aria-label="원본 TXT 샘플" value={rawLines.join("\n")} />
          </div>
        </section>

        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><SlidersHorizontal aria-hidden="true" />컬럼 설정</h2>
            <div className="record-parsing-panel-actions">
              {hasClickEventPreset ? (
                <Button
                  className="record-parsing-preset-button"
                  disabled={loading || parsing.expectedFieldCount !== CLICK_EVENT_RECORD_SCHEMA_PRESET.length}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={applyRecommendedSchema}
                >
                  <Sparkles aria-hidden="true" />
                  추천 스키마 적용
                </Button>
              ) : null}
              <span className={cn("record-parsing-status", preview?.invalidRows.length && "is-warning")}>
                {!loading && preview && !preview.invalidRows.length ? <Check aria-hidden="true" /> : null}
                {loading ? "검증 중" : preview ? `${preview.validRows}/${preview.totalRows} 정상` : "검증 대기"}
              </span>
            </div>
          </div>
          <div className="record-parsing-panel-body record-parsing-settings-body">
            <div className="record-parsing-controls">
              <FormFieldGroup className="field" label="필드 구분자">
                <NativeSelect disabled value="whitespace"><option value="whitespace">연속 공백 (\\s+)</option></NativeSelect>
              </FormFieldGroup>
              <FormFieldGroup className="field" label="헤더 처리">
                <NativeSelect value={parsing.header ? "first" : "none"} onChange={(event) => updateHeader(event.target.value === "first")}>
                  <option value="none">헤더 없음</option>
                  <option value="first">첫 줄을 헤더로 사용</option>
                </NativeSelect>
              </FormFieldGroup>
            </div>
            {error && <p className="record-parsing-error">{error}</p>}
            <ScrollArea type="always" scrollbars="horizontal" className="record-parsing-table-scroll">
              <table className="schema-table record-parsing-table">
                <thead><tr><th>순서</th><th>샘플 값</th><th>출력 컬럼명</th><th>추론 타입</th></tr></thead>
                <tbody>
                  {parsing.columns.map((column) => (
                    <tr key={column.position}>
                      <td>{column.position + 1}</td>
                      <td><code>{preview?.sampleRows[0]?.[column.position] || "-"}</code></td>
                      <td><Input aria-label={`${column.position + 1}번째 출력 컬럼명`} value={column.name} onChange={(event) => updateColumn(column.position, { name: event.target.value })} /></td>
                      <td>
                        <NativeSelect value={column.inferredType} onChange={(event) => updateColumn(column.position, { inferredType: event.target.value as RecordParsingDraft["columns"][number]["inferredType"] })}>
                          {schemaTypeOptions.filter((type) => type !== "JSON").map((type) => <option key={type} value={type}>{type}</option>)}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
            {!columnNamesValid && <p className="record-parsing-error">컬럼명은 비어 있거나 중복될 수 없습니다.</p>}
          </div>
        </section>
      </div>

      {preview?.invalidRows.length ? (
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header record-parsing-panel-header-warning"><h2><Info aria-hidden="true" />필드 개수 불일치</h2></div>
          <div className="record-parsing-panel-body">
            <table className="schema-table record-parsing-invalid-table">
              <thead><tr><th>원본 행</th><th>예상</th><th>실제</th><th>원문</th></tr></thead>
              <tbody>{preview.invalidRows.map((row) => <tr key={row.lineNumber}><td>{row.lineNumber}</td><td>{row.expectedFieldCount}</td><td>{row.actualFieldCount}</td><td><code>{row.rawPreview}</code></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : preview && (
        <section className="panel record-parsing-panel">
          <div className="record-parsing-panel-header">
            <h2><Table2 aria-hidden="true" />결과 미리보기</h2>
          </div>
          <div className="record-parsing-panel-body record-parsing-preview-body">
            <ScrollArea type="always" scrollbars="horizontal" className="record-parsing-table-scroll">
              <table className="schema-table record-parsing-preview-table">
                <thead><tr>{parsing.columns.map((column) => <th key={column.position}>{column.name}</th>)}</tr></thead>
                <tbody>{preview.sampleRows.slice(0, 5).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </ScrollArea>
          </div>
        </section>
      )}
    </CreationFlowLayout>
  );
}
