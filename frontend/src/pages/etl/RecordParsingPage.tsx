import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Info,
  SlidersHorizontal,
  Sparkles,
  Table2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { previewRecordParsing } from "../../services/sourceConnectorService";
import type {
  AuditResult,
  DraftPipeline,
  DraftPipelinePatch,
  RecordParsingDraft,
  RecordParsingInvalidRow,
  RecordParsingPreviewResponse,
  SchemaColumnDraft,
} from "../../types";
import {
  buildSchemaFingerprint,
  normalizeTargetColumnName,
  schemaTypeOptions,
} from "./schemaModel";

type RecordParsingResultRow = {
  id: string;
  values: string[];
};

type RecordParsingColumnDraft = RecordParsingDraft["columns"][number];

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
  const [rawSampleExpanded, setRawSampleExpanded] = useState(true);
  const [resultPreviewExpanded, setResultPreviewExpanded] = useState(true);

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

  const normalizedNames = parsing.columns.map((column) => normalizeTargetColumnName(column.name));
  const columnNamesValid = normalizedNames.every(Boolean) && new Set(normalizedNames).size === normalizedNames.length;
  const canApply = Boolean(preview?.canApply && columnNamesValid && parsing.columns.length === parsing.expectedFieldCount);
  const fieldInferenceColumns: ColumnDef<RecordParsingColumnDraft>[] = [
    {
      cell: ({ row }) => row.original.position + 1,
      header: "순서",
      id: "position",
      meta: { widthClassName: "w-20" },
    },
    {
      cell: ({ row }) => (
        <code className="record-parsing-code-cell">
          {preview?.sampleRows[0]?.[row.original.position] || "-"}
        </code>
      ),
      header: "샘플 값",
      id: "sample-value",
      meta: { widthClassName: "min-w-56" },
    },
    {
      cell: ({ row }) => (
        <Input
          aria-label={`${row.original.position + 1}번째 출력 컬럼명`}
          value={row.original.name}
          onChange={(event) => updateColumn(row.original.position, { name: event.target.value })}
        />
      ),
      header: "출력 컬럼명",
      id: "output-column-name",
      meta: { widthClassName: "min-w-52" },
    },
    {
      cell: ({ row }) => (
        <NativeSelect
          value={row.original.inferredType}
          onChange={(event) => updateColumn(row.original.position, {
            inferredType: event.target.value as RecordParsingColumnDraft["inferredType"],
          })}
        >
          {schemaTypeOptions.filter((type) => type !== "JSON").map((type) => <option key={type} value={type}>{type}</option>)}
        </NativeSelect>
      ),
      header: "추론 타입",
      id: "inferred-type",
      meta: { widthClassName: "min-w-44" },
    },
  ];
  const invalidRowColumns: ColumnDef<RecordParsingInvalidRow>[] = [
    { accessorKey: "lineNumber", header: "원본 행", meta: { widthClassName: "w-28" } },
    { accessorKey: "expectedFieldCount", header: "예상", meta: { widthClassName: "w-24" } },
    { accessorKey: "actualFieldCount", header: "실제", meta: { widthClassName: "w-24" } },
    {
      cell: ({ row }) => <code className="record-parsing-code-cell">{row.original.rawPreview}</code>,
      header: "원문",
      id: "raw-preview",
      meta: { widthClassName: "min-w-[32rem]" },
    },
  ];
  const resultRows: RecordParsingResultRow[] = (preview?.sampleRows ?? []).slice(0, 5).map((values, index) => ({
    id: `record-parsing-result-${index}`,
    values,
  }));
  const resultColumns: ColumnDef<RecordParsingResultRow>[] = parsing.columns.map((column) => ({
    cell: ({ row }) => {
      const value = row.original.values[column.position] ?? "-";
      return <span className="record-parsing-result-cell" title={value}>{value}</span>;
    },
    enableSorting: false,
    header: column.name,
    id: `record-parsing-result-${column.position}`,
    meta: { widthClassName: "min-w-40" },
  }));

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
      actions={<CreationTopActions nextDisabled={!canApply || loading} split onPrev={onPrev} onNext={applyAndContinue} />}
    >
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<SlidersHorizontal />}
        title="레코드 구조화"
      />

      <div className="record-parsing-workspace">
        <section className="panel record-parsing-panel">
          <EtlSectionHeader
            actions={(
              <button
                aria-controls="record-parsing-raw-sample"
                aria-expanded={rawSampleExpanded}
                aria-label={rawSampleExpanded ? "원본 샘플 접기" : "원본 샘플 펼치기"}
                className="record-parsing-collapse-button"
                type="button"
                onClick={() => setRawSampleExpanded((expanded) => !expanded)}
              >
                {rawSampleExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            )}
            icon={<FileText />}
            title="원본 샘플"
          />
          {rawSampleExpanded ? (
            <div className="record-parsing-panel-body" id="record-parsing-raw-sample">
              <textarea className="input record-parsing-raw" readOnly aria-label="원본 TXT 샘플" value={rawLines.join("\n")} />
            </div>
          ) : null}
        </section>

        <section className="panel record-parsing-panel">
          <EtlSectionHeader
            actions={(
              <Button
                className="record-parsing-ai-button"
                data-testid="record-parsing-ai-button"
                size="sm"
                type="button"
                variant="outline"
              >
                <Sparkles aria-hidden="true" />
                AI 필드 자동 추론
              </Button>
            )}
            icon={<SlidersHorizontal />}
            title="필드 추론"
          />
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
            <DataTable
              aria-label="필드 추론 표"
              cellClassName="text-sm text-slate-800"
              columns={fieldInferenceColumns}
              data={parsing.columns}
              enableSorting={false}
              getRowId={(row) => String(row.position)}
              pagination={false}
              tableClassName="record-parsing-data-table min-w-[720px]"
              viewportClassName="record-parsing-data-table-viewport"
            />
            {!columnNamesValid && <p className="record-parsing-error">컬럼명은 비어 있거나 중복될 수 없습니다.</p>}
          </div>
        </section>
      </div>

      {preview?.invalidRows.length ? (
        <section className="panel record-parsing-panel">
          <EtlSectionHeader icon={<Info />} title="필드 개수 불일치" tone="warning" />
          <div className="record-parsing-panel-body">
            <DataTable
              aria-label="필드 개수 불일치 표"
              cellClassName="text-sm text-slate-800"
              columns={invalidRowColumns}
              data={preview.invalidRows}
              enableSorting={false}
              getRowId={(row) => String(row.lineNumber)}
              pagination={false}
              tableClassName="record-parsing-data-table min-w-[720px]"
              viewportClassName="record-parsing-data-table-viewport"
            />
          </div>
        </section>
      ) : preview && (
        <section className="panel record-parsing-panel">
          <EtlSectionHeader
            actions={(
              <button
                aria-controls="record-parsing-result-preview"
                aria-expanded={resultPreviewExpanded}
                aria-label={resultPreviewExpanded ? "결과 미리보기 접기" : "결과 미리보기 펼치기"}
                className="record-parsing-collapse-button"
                type="button"
                onClick={() => setResultPreviewExpanded((expanded) => !expanded)}
              >
                {resultPreviewExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            )}
            icon={<Table2 />}
            title="결과 미리보기"
          />
          {resultPreviewExpanded ? (
            <div className="record-parsing-panel-body record-parsing-preview-body" id="record-parsing-result-preview">
              <DataTable
                aria-label="레코드 구조화 결과 미리보기 표"
                cellClassName="text-sm text-slate-800"
                columns={resultColumns}
                data={resultRows}
                enableSorting={false}
                getRowId={(row) => row.id}
                pagination={false}
                tableClassName="record-parsing-data-table min-w-max"
                viewportClassName="record-parsing-data-table-viewport"
              />
            </div>
          ) : null}
        </section>
      )}
    </CreationFlowLayout>
  );
}
