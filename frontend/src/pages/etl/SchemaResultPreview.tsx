import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, ChevronDown, ChevronUp, Table2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EtlSectionHeader } from "@/components/etl/EtlSectionHeader";
import { Panel } from "@/components/ui/panel";
import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../../types";
import { buildSchemaResultPreviewModel, type SchemaPreviewModelRow } from "./schemaResultPreviewModel";

type SchemaResultPreviewProps = {
  columns: SchemaColumnDraft[];
  qualityRules: QualityRuleDraft[];
  sampleRows: string[][];
  transformSteps: TransformStepDraft[];
};

const COLLAPSED_ROW_COUNT = 3;
const EXPANDED_ROW_LIMIT = 20;

export function SchemaResultPreview({ columns, qualityRules, sampleRows, transformSteps }: SchemaResultPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const previewModel = useMemo(() => buildSchemaResultPreviewModel({
    columns,
    qualityRules,
    sampleRows,
    transformSteps,
  }), [columns, qualityRules, sampleRows, transformSteps]);
  const { outputColumns } = previewModel;
  const visibleRows = previewModel.rows.slice(0, expanded ? EXPANDED_ROW_LIMIT : COLLAPSED_ROW_COUNT);
  const tableColumns = useMemo<ColumnDef<SchemaPreviewModelRow>[]>(() => {
    const valueColumns: ColumnDef<SchemaPreviewModelRow>[] = outputColumns.map(({ column }, outputIndex) => ({
      cell: ({ row }) => {
        const value = row.original.values[outputIndex];
        return <span title={value || "-"}>{formatPreviewValue(value)}</span>;
      },
      enableSorting: false,
      header: () => (
        <span className="schema-result-preview-heading">
          <strong>{column.targetName || column.sourceName}</strong>
          <small>{column.type}</small>
        </span>
      ),
      id: `${column.targetName || column.sourceName}-${outputIndex}`,
    }));
    const resultColumn: ColumnDef<SchemaPreviewModelRow> = {
      cell: ({ row }) => (
        <span className={row.original.result.issueCount > 0 ? "schema-preview-status warning" : "schema-preview-status success"}>
          {row.original.result.issueCount > 0 ? <AlertTriangle /> : null}
          {row.original.result.label}
        </span>
      ),
      enableSorting: false,
      header: "검증 결과",
      id: "validation-result",
      meta: {
        cellClassName: "schema-result-column",
        headerClassName: "schema-result-column",
      },
    };
    return [...valueColumns, resultColumn];
  }, [outputColumns]);
  const canExpand = sampleRows.length > COLLAPSED_ROW_COUNT;
  const hiddenRowCount = Math.max(0, Math.min(sampleRows.length, EXPANDED_ROW_LIMIT) - COLLAPSED_ROW_COUNT);

  return (
    <Panel className="schema-result-preview mt-4" variant="plain">
      <EtlSectionHeader
        description={`샘플 ${Math.min(sampleRows.length, EXPANDED_ROW_LIMIT)}행 중 ${visibleRows.length}행 표시`}
        icon={<Table2 />}
        title="결과 미리보기"
      />

      {outputColumns.length > 0 && visibleRows.length > 0 ? (
        <DataTable
          bodyRowClassName="schema-result-preview-row"
          cellClassName="schema-result-preview-cell"
          columns={tableColumns}
          data={visibleRows}
          enableSorting={false}
          getRowId={(row) => row.id}
          headerRowClassName="schema-result-preview-header-row"
          pagination={false}
          tableClassName="schema-result-preview-shadcn-table min-w-[720px]"
          viewportClassName={expanded ? "schema-result-preview-table is-expanded" : "schema-result-preview-table"}
        />
      ) : (
        <div className="schema-result-preview-empty">
          출력 컬럼과 샘플 데이터가 준비되면 결과를 확인할 수 있습니다.
        </div>
      )}

      <footer className="schema-result-preview-footer">
        <span>
          {sampleRows.length > EXPANDED_ROW_LIMIT
            ? `전체 샘플 중 최대 ${EXPANDED_ROW_LIMIT}행까지 확인할 수 있습니다.`
            : `전체 샘플 ${sampleRows.length}행`}
        </span>
        {canExpand ? (
          <Button
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            size="sm"
            type="button"
            variant="outline"
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
            {expanded ? "간단히 보기" : `나머지 ${hiddenRowCount}행 펼치기`}
          </Button>
        ) : null}
      </footer>
    </Panel>
  );
}

function formatPreviewValue(value: string | undefined) {
  if (value === undefined || value === null || value === "") return "-";
  return value;
}
