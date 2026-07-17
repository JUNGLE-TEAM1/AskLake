import { ActionGroup } from "@/components/ui/action-group";
import { Button } from "@/components/ui/button";
import { CommandBar } from "@/components/ui/command-bar";
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2
} from "lucide-react";
import { Field, StatusTile } from "../../components/common";
import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import type { TransformQualityInvalidRow, TransformQualityPreviewSample, TransformQualitySampleRow, TransformQualityStepPreview } from "../../data/transformQualityPreview";

import {
  buildStepImpactRows,
  downloadCsv,
  failureActionLabel,
  qualityFailureReasonLabel,
  QualityRule,
  qualitySeverityLabel,
  qualityValidationLabel,
  RecipeStep,
  RuleActionHandler,
  transformOperationLabel
} from "./ruleModel";

export function RuleBottomBar({
  invalidRowCount,
  invalidRowsVisible,
  onInvalidRows,
  onNext,
  onPrev,
  onSave,
  onTest,
}: {
  invalidRowCount: number;
  invalidRowsVisible: boolean;
  onInvalidRows: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <CommandBar className="hegun-rule-bottom-bar" layout="sticky">
      <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>스키마로 돌아가기</Button>
      <Button className="ghost-button hegun-bottom-command" type="button" variant="ghost" onClick={onTest}>
        <Search size={16} />
        샘플 테스트 (1,000개 행)
      </Button>
      <Button className={invalidRowsVisible ? "ghost-button hegun-bottom-command active" : "ghost-button hegun-bottom-command"} type="button" variant="ghost" onClick={onInvalidRows}>
        <Info size={16} />
        유효하지 않은 행 보기 ({invalidRowCount})
      </Button>
      <span className="hegun-target-engine">실행 엔진<br /><strong>Spark</strong></span>
      <Button className="secondary-button" type="button" variant="outline" onClick={onSave}>임시 저장</Button>
      <Button className="primary-button" type="button" onClick={onNext}>실행 준비 완료</Button>
    </CommandBar>
  );
}

export function FinalDatasetPreviewPanel({
  columns,
  derivedColumns,
  invalidRowCount,
  rows,
  totalRows,
  transformStepCount,
}: {
  columns: string[];
  derivedColumns: string[];
  invalidRowCount: number;
  rows: TransformQualitySampleRow[];
  totalRows: number;
  transformStepCount: number;
}) {
  const previewRows = rows.slice(0, 10);
  const derivedColumnSet = new Set(derivedColumns);
  const showingRowsLabel = `${totalRows.toLocaleString()}행 중 ${previewRows.length.toLocaleString()}행 표시`;
  const summaryItems = [
    { label: "처리된 샘플 행", value: totalRows.toLocaleString() },
    { label: "적용된 변환 단계", value: transformStepCount.toLocaleString() },
    { label: "생성된 파생 컬럼", value: derivedColumns.length.toLocaleString() },
    { label: "유효하지 않은 행", value: invalidRowCount.toLocaleString() },
  ];
  const tableColumns: ColumnDef<TransformQualitySampleRow>[] = columns.map((column) => ({
    cell: ({ row }) => row.original[column] ?? "",
    header: () => (
      <span className="hegun-final-column-header">
        {column}
        {derivedColumnSet.has(column) && <em>파생</em>}
      </span>
    ),
    id: column,
  }));

  return (
    <section className="panel hegun-console-panel hegun-final-preview-panel">
      <EtlSectionHeader className="mb-5 rounded-lg" description={showingRowsLabel} icon={<Table2 />} title="최종 데이터셋 미리보기" />
      <div className="hegun-final-preview-summary">
        {summaryItems.map((item) => (
          <article key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </div>
      <DataTable
        aria-label="최종 데이터셋 미리보기 표"
        columns={tableColumns}
        data={previewRows}
        emptyState={<span className="hegun-empty-table-state">변환된 샘플 행이 없습니다.</span>}
        enableSorting={false}
        getRowId={(row, index) => String(row.row_id ?? `row-${index}`)}
        pagination={false}
        tableClassName="schema-table hegun-final-preview-table"
        viewportClassName="hegun-table-scroll"
      />
      <div className="hegun-final-preview-footer">{showingRowsLabel}</div>
    </section>
  );
}

export function StepPreviewAnalysis({
  onAction,
  preview,
  step,
}: {
  onAction: RuleActionHandler;
  preview?: TransformQualityPreviewSample | TransformQualityStepPreview;
  step: RecipeStep;
}) {
  const hasPreview = Boolean(preview);
  const inputValue = preview?.inputValue ?? "";
  const outputValue = preview?.outputValue ?? "";
  const failedRows = preview?.failedRows ?? 0;
  const previewStatus = preview?.status ?? "Preview pending";
  const previewStatusLabel = previewStatus === "Success" ? "성공" : previewStatus === "Review" ? "검토 필요" : "미리보기 대기";
  const beforeRows = preview && "beforeRows" in preview ? preview.beforeRows : [];
  const afterRows = preview && "afterRows" in preview ? preview.afterRows : [];
  const matchedRows = preview?.matchedRows ?? beforeRows.length;
  const sampleRows = preview ? matchedRows + failedRows : 0;
  const previewColumns = preview && "columns" in preview ? preview.columns : ["row_id", step.input, step.output].filter(Boolean);
  const impactRows = buildStepImpactRows(beforeRows, afterRows, previewColumns, step, preview);
  return (
    <section className="panel hegun-console-panel">
      <EtlSectionHeader
        actions={<Button className="secondary-button hegun-header-button" type="button" variant="outline" onClick={() => onAction("etl.rules.sample_rows_refetched", "/api/etl/rules/sample-rows")}>새 샘플 행 가져오기</Button>}
        className="mb-5 rounded-lg"
        icon={<RefreshCw />}
        title="단계 미리보기 및 분석"
      />
      <div className="hegun-selected-step-banner">
        <span>선택 단계</span>
        <strong>{step.id}. {transformOperationLabel(step.operation)}</strong>
        <em>{step.input} {"->"} {step.output}</em>
      </div>
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>단계 상세</h3>
          <Field label="입력 컬럼" value={step.input} />
          <Field label="출력 컬럼" value={step.output} />
          <Field label="처리 작업" value={transformOperationLabel(step.operation)} />
          <Field label="오류 처리" value={failureActionLabel(step.onError)} />
          <Field label="옵션" value={step.params} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>입력에서 출력으로</h3>
          <Field label="입력 값" value={inputValue} wide />
          <div className="hegun-preview-arrow">→</div>
          <Field label="출력 값" value={outputValue} wide />
          <span className="hegun-success-state"><Check size={14} /> {previewStatusLabel}</span>
        </div>
        <div className="hegun-preview-column">
          <h3>샘플 통계</h3>
          <StatusTile label="샘플 행" value={sampleRows.toLocaleString()} status="테스트 완료" />
          <StatusTile label="일치 행" value={matchedRows.toLocaleString()} status="일치" />
          <StatusTile label="실패 행" value={String(failedRows)} status={failedRows > 0 ? "검토" : hasPreview ? "정상" : "대기"} />
          <StatusTile label="영향 컬럼" value={preview?.affectedColumn ?? step.output} status={hasPreview ? "출력" : "대기"} />
        </div>
      </div>
      <div className="hegun-impact-header">
        <div>
          <h3>규칙 영향 미리보기</h3>
          <p>{matchedRows.toLocaleString()}개 일치 행에 {transformOperationLabel(step.operation)}을 적용했습니다. 대표 {impactRows.length}개 행을 표시합니다.</p>
        </div>
        <span>{previewStatusLabel}</span>
      </div>
      <StepImpactRowsTable rows={impactRows} step={step} />
    </section>
  );
}

export function StepImpactRowsTable({
  rows,
  step,
}: {
  rows: ReturnType<typeof buildStepImpactRows>;
  step: RecipeStep;
}) {
  type StepImpactRow = ReturnType<typeof buildStepImpactRows>[number];
  const columns: ColumnDef<StepImpactRow>[] = [
    { cell: ({ row }) => <strong>{row.original.rowId}</strong>, header: "행", id: "row" },
    { cell: ({ row }) => <code className="hegun-impact-value">{row.original.beforeValue}</code>, header: `이전: ${step.input}`, id: "before" },
    { cell: () => <span className="hegun-data-chip muted">{transformOperationLabel(step.operation)}</span>, header: "변환", id: "operation" },
    { cell: ({ row }) => <code className="hegun-impact-value output">{row.original.afterValue}</code>, header: `이후: ${step.output}`, id: "after" },
    { cell: ({ row }) => <span className={`hegun-impact-status ${row.original.statusClass}`}>{row.original.statusLabel}</span>, header: "상태", id: "status" },
  ];

  return (
    <DataTable
      aria-label="규칙 영향 미리보기 표"
      columns={columns}
      data={rows}
      enableSorting={false}
      getRowId={(row) => `${row.rowId}-${row.beforeValue}-${row.afterValue}`}
      pagination={false}
      tableClassName="schema-table hegun-impact-table"
      viewportClassName="hegun-table-scroll"
    />
  );
}

export function QualityPreviewAnalysis({
  invalidRows,
  onAction,
  rule,
  sampleRows,
}: {
  invalidRows: TransformQualityInvalidRow[];
  onAction: RuleActionHandler;
  rule: QualityRule;
  sampleRows: number;
}) {
  const invalidRowCount = invalidRows.length;
  const matchedRows = Math.max(0, sampleRows - invalidRowCount);
  const qualityScore = sampleRows ? Number(((matchedRows / sampleRows) * 100).toFixed(1)) : 100;
  const firstFailure = invalidRows[0];
  return (
    <section className="panel hegun-console-panel">
      <EtlSectionHeader
        actions={<Button className="secondary-button hegun-header-button" type="button" variant="outline" onClick={() => onAction("etl.rules.quality_sample_refetched", "/api/etl/rules/quality/sample-rows")}>새 샘플 행 가져오기</Button>}
        className="mb-5 rounded-lg"
        icon={<ShieldCheck />}
        title="품질 검증 미리보기"
      />
      <div className="hegun-preview-grid">
        <div className="hegun-preview-column">
          <h3>규칙 상세</h3>
          <Field label="대상 컬럼" value={rule.targetColumn} />
          <Field label="검증" value={qualityValidationLabel(rule.validationType)} />
          <Field label="심각도" value={qualitySeverityLabel(rule.severity)} />
          <Field label="실패 처리" value={failureActionLabel(rule.failureAction)} />
          <Field label="상태" value={rule.severity === "Error" ? "차단" : "모니터링"} wide />
        </div>
        <div className="hegun-preview-column hegun-before-after">
          <h3>샘플 실패</h3>
          <Field label="행" value={firstFailure?.row ?? "실패 샘플 없음"} />
          <Field label="컬럼" value={firstFailure?.column ?? rule.targetColumn} />
          <Field label="샘플 값" value={firstFailure?.sampleValue || "(비어 있음)"} wide />
          <Field label="사유" value={firstFailure ? qualityFailureReasonLabel(firstFailure.reason) : "샘플 행이 모두 통과했습니다."} wide />
          <Field label="처리" value={failureActionLabel(firstFailure?.action ?? rule.failureAction)} />
          <span className={invalidRowCount > 0 ? "hegun-warning-state" : "hegun-success-state"}>
            <Info size={14} /> {invalidRowCount > 0 ? "검토 필요" : "성공"}
          </span>
        </div>
        <div className="hegun-preview-column">
          <h3>샘플 통계</h3>
          <StatusTile label="샘플 행" value={sampleRows.toLocaleString()} status="테스트 완료" />
          <StatusTile label="통과 행" value={matchedRows.toLocaleString()} status="통과" />
          <StatusTile label="유효하지 않은 행" value={String(invalidRowCount)} status={invalidRowCount > 0 ? "검토" : "정상"} />
          <StatusTile label="품질 점수" value={`${qualityScore}%`} status={invalidRowCount > 0 ? "주의" : "통과"} />
        </div>
      </div>
    </section>
  );
}

export function QualityFailedRowsPanel({
  invalidRows,
  onAction,
  rule,
}: {
  invalidRows: TransformQualityInvalidRow[];
  onAction: RuleActionHandler;
  rule: QualityRule;
}) {
  const previewRows = invalidRows.slice(0, 12);
  const rowSummary = invalidRows.length === 0
    ? "선택한 검사에서 실패 행이 없습니다."
    : `${rule.targetColumn}의 ${qualityValidationLabel(rule.validationType)} 실패 행 ${invalidRows.length}개`;
  const columns: ColumnDef<TransformQualityInvalidRow>[] = [
    { accessorKey: "row", header: "행" },
    { accessorKey: "column", header: "컬럼" },
    { cell: ({ row }) => <code className="hegun-impact-value">{row.original.sampleValue || "(비어 있음)"}</code>, header: "샘플 값", id: "sample-value" },
    { cell: ({ row }) => qualityFailureReasonLabel(row.original.reason), header: "사유", id: "reason" },
    { cell: ({ row }) => <span className="hegun-data-chip muted">{failureActionLabel(row.original.action)}</span>, header: "처리", id: "action" },
  ];
  return (
    <section className="panel hegun-console-panel hegun-quality-failures-panel">
      <EtlSectionHeader className="mb-5 rounded-lg" description={rowSummary} icon={<Table2 />} title="선택 검사 실패 행" tone="warning" />
      <DataTable
        aria-label="선택 검사 실패 행 표"
        columns={columns}
        data={previewRows}
        emptyState={<span className="hegun-empty-table-state">선택한 검사가 모든 샘플 행을 통과했습니다.</span>}
        enableSorting={false}
        getRowId={(row) => `${row.ruleId ?? rule.id}-${row.row}-${row.column}-${row.reason}`}
        pagination={false}
        tableClassName="schema-table hegun-quality-failed-table"
        viewportClassName="hegun-table-scroll"
      />
      <ActionGroup className="hegun-rule-form-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={() => {
          downloadCsv("asklake-quality-failed-rows.csv", ["행", "컬럼", "샘플 값", "사유", "처리"], previewRows.map((row) => [row.row, row.column, row.sampleValue, qualityFailureReasonLabel(row.reason), failureActionLabel(row.action)]));
          onAction("etl.rules.quality_failed_rows_exported", "/api/etl/rules/quality/failed-rows/export");
        }}>행 내보내기</Button>
        <Button className="primary-button" type="button" onClick={() => onAction("etl.rules.quality_failed_rows_reviewed", "/api/etl/rules/quality/failed-rows/review")}>검토 완료</Button>
      </ActionGroup>
    </section>
  );
}

export function InvalidRowsPanel({
  invalidRows,
  invalidRowsPreviewSummary,
  onAction,
}: {
  invalidRows: TransformQualityInvalidRow[];
  invalidRowsPreviewSummary: string;
  onAction: RuleActionHandler;
}) {
  const columns: ColumnDef<TransformQualityInvalidRow>[] = [
    { accessorKey: "row", header: "행" },
    { accessorKey: "column", header: "컬럼" },
    { cell: ({ row }) => qualityFailureReasonLabel(row.original.reason), header: "사유", id: "reason" },
    { cell: ({ row }) => <span className="hegun-data-chip muted">{failureActionLabel(row.original.action)}</span>, header: "처리", id: "action" },
    { cell: ({ row }) => <code className="hegun-impact-value">{row.original.sampleValue || "(비어 있음)"}</code>, header: "샘플 값", id: "sample-value" },
  ];
  return (
    <section className="panel hegun-console-panel hegun-invalid-panel">
      <EtlSectionHeader className="mb-5 rounded-lg" description={invalidRowsPreviewSummary} icon={<Info />} title="유효하지 않은 데이터 행" tone="danger" />
      <DataTable
        aria-label="유효하지 않은 데이터 행 표"
        columns={columns}
        data={invalidRows}
        enableSorting={false}
        getRowId={(row) => `${row.row}-${row.column}`}
        pagination={false}
        tableClassName="schema-table"
        viewportClassName="hegun-table-scroll"
      />
      <ActionGroup className="hegun-rule-form-actions" density="compact">
        <Button className="secondary-button" type="button" variant="outline" onClick={() => {
          downloadCsv("asklake-invalid-rows.csv", ["행", "컬럼", "사유", "처리", "샘플 값"], invalidRows.map((row) => [row.row, row.column, qualityFailureReasonLabel(row.reason), failureActionLabel(row.action), row.sampleValue]));
          onAction("etl.rules.invalid_rows_exported", "/api/etl/rules/invalid-rows/export");
        }}>행 내보내기</Button>
        <Button className="primary-button" type="button" onClick={() => onAction("etl.rules.invalid_rows_reviewed", "/api/etl/rules/invalid-rows/review")}>검토 완료</Button>
      </ActionGroup>
    </section>
  );
}
