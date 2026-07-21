import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { KeyValueList } from "@/components/ui/key-value-list";
import { ValidationList } from "@/components/ui/validation-list";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Database,
  FileText,
  HardDrive,
  Pencil,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import {
  buildReviewSnapshotRequest,
  getReviewSnapshot,
  getReviewSnapshotRequestKey,
  type ReviewSnapshot,
  type ReviewSnapshotRequest,
} from "../../services/reviewApi";
import type { DraftPipeline, FlowId } from "../../types";

import {
  ReviewSchemaRow
} from "./targetModel";

export function ReviewPage({
  createPending,
  draft,
  onCreate,
  onEdit,
}: {
  createPending?: boolean;
  draft: DraftPipeline;
  onCreate: (dashboardBinding?: { title: string }) => void;
  onEdit: (flow: FlowId) => void;
  onSave: () => void;
}) {
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewError, setReviewError] = useState("");
  const [reviewRetryCount, setReviewRetryCount] = useState(0);
  const [dashboardBindingEnabled, setDashboardBindingEnabled] = useState(false);
  const [dashboardTitle, setDashboardTitle] = useState("");
  const reviewRequestKey = getReviewSnapshotRequestKey(buildReviewSnapshotRequest(draft));
  const reviewRequest = useMemo(
    () => JSON.parse(reviewRequestKey) as ReviewSnapshotRequest,
    [reviewRequestKey],
  );

  useEffect(() => {
    let cancelled = false;
    setReviewLoading(true);
    setReviewError("");
    setReviewSnapshot(null);
    void getReviewSnapshot(reviewRequest)
      .then((snapshot) => {
        if (!cancelled) setReviewSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReviewError(error instanceof Error ? error.message : "검토 정보를 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewRequest, reviewRetryCount]);

  const basicInformationRows = reviewSnapshot?.basicInformation ?? [];
  const destinationRows = (reviewSnapshot?.destination ?? []).filter(
    ({ label }) => label !== "테이블 이름" && label !== "계층",
  );
  const permissionRows = reviewSnapshot?.permission ?? [];
  const schemaRows = reviewSnapshot?.schema ?? [];
  const validationRows = reviewSnapshot?.validation ?? [];
  const canCreate = reviewSnapshot?.canCreate === true;
  const createDisabled = createPending || reviewLoading || !canCreate;
  const createLabel = createPending
    ? "생성 중..."
    : reviewLoading
      ? "서버 확인 중..."
      : reviewError
        ? "검토 오류"
        : canCreate
          ? "파이프라인 생성"
          : "검증 필요";

  return (
    <CreationFlowLayout
      variant="review"
      actions={<CreationTopActions nextDisabled={createDisabled} nextLabel={createLabel} split onPrev={() => onEdit("target")} onNext={() => onCreate(dashboardBindingEnabled ? { title: dashboardTitle.trim() || `${draft.target.datasetName.trim() || "Job 결과"} Dashboard` } : undefined)} />}
    >
        <EtlStepHeader
          className="etl-step-standalone-header"
          icon={<FileText />}
          title="검토 및 생성"
        />
        {reviewError ? (
          <Alert className="mx-0" variant="destructive">
            <AlertTitle>검토 정보를 불러오지 못했습니다.</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{reviewError}</span>
              <Button size="sm" type="button" variant="outline" onClick={() => setReviewRetryCount((count) => count + 1)}>
                <RefreshCw aria-hidden="true" data-icon="inline-start" /> 다시 시도
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="etl-review-stack">
          <section className="etl-review-card">
            <EtlSectionHeader icon={<Check />} title="생성 준비 상태" tone="success" />
            <ValidationList
              className="etl-review-validation"
              items={validationRows.map(({ label, status, value }) => ({
                label,
                status,
                value,
              }))}
            />
          </section>

          <section className="etl-review-card">
            <EtlSectionHeader icon={<Database />} title="Dashboard 연동" />
            <div className="bg-slate-50/70 p-5">
              <label className="flex cursor-pointer items-start gap-3" htmlFor="etl-dashboard-binding-enabled">
                <Checkbox checked={dashboardBindingEnabled} id="etl-dashboard-binding-enabled" onCheckedChange={(checked) => setDashboardBindingEnabled(checked === true)} />
                <span className="grid gap-1"><strong className="text-sm text-slate-900">결과를 Dashboard에 자동 반영</strong><small className="text-sm leading-5 text-slate-500">새 Dashboard를 만들고 출력 Dataset을 고정합니다.</small></span>
              </label>
              {dashboardBindingEnabled ? (
                <Field className="mt-5 rounded-lg border border-blue-100 bg-white p-4">
                  <FieldLabel htmlFor="etl-dashboard-title">Dashboard 이름</FieldLabel>
                  <Input id="etl-dashboard-title" className="mt-2" maxLength={160} value={dashboardTitle} onChange={(event) => setDashboardTitle(event.target.value)} placeholder={`${draft.target.datasetName || "Job 결과"} Dashboard`} />
                  <FieldDescription>첫 실행 후 차트를 만들 수 있고, Widget과 시각화 설정은 계속 편집할 수 있습니다.</FieldDescription>
                </Field>
              ) : null}
            </div>
          </section>

          <section className="etl-review-card">
            <EtlSectionHeader actions={<ReviewEditButton label="기본 정보 수정" onClick={() => onEdit("target")} />} icon={<FileText />} title="기본 정보" />
            <KeyValueList
              className="etl-review-kv"
              items={basicInformationRows.map(({ label, value }) => ({
                label,
                value,
              }))}
            />
          </section>

          <section className="etl-review-card">
            <EtlSectionHeader actions={<ReviewEditButton label="출력 스키마 수정" onClick={() => onEdit("schema")} />} icon={<Database />} title="출력 스키마" />
            <ReviewSchemaTable rows={schemaRows} />
          </section>

          <section className="etl-review-card">
            <EtlSectionHeader actions={<ReviewEditButton label="저장 위치 수정" onClick={() => onEdit("target")} />} icon={<HardDrive />} title="저장 위치 설정" />
            <KeyValueList
              className="etl-review-kv destination"
              items={destinationRows.map(({ label, value }) => ({
                className: label === "저장 경로" ? "wide" : undefined,
                label,
                value,
              }))}
            />
          </section>

          <section className="etl-review-card">
            <EtlSectionHeader actions={<ReviewEditButton label="권한 설정 수정" onClick={() => onEdit("permission")} />} icon={<ShieldCheck />} title="권한 설정" />
            <KeyValueList
              className="etl-review-kv permission"
              items={permissionRows.map(({ label, value }) => ({
                label,
                value,
              }))}
            />
          </section>
        </div>
    </CreationFlowLayout>
  );
}

function ReviewEditButton({ label, onClick }: { label: string; onClick: () => void; }) {
  return (
    <Button aria-label={label} className="etl-review-edit" size="sm" type="button" variant="outline" onClick={onClick}>
      <Pencil aria-hidden="true" data-icon="inline-start" /> 수정
    </Button>
  );
}

function ReviewSchemaTable({ rows }: { rows: ReviewSchemaRow[] }) {
  const columns = useMemo<ColumnDef<ReviewSchemaRow>[]>(
    () => [
      { accessorKey: "columnName", cell: (info) => info.getValue<string>(), header: "컬럼명" },
      { accessorKey: "type", cell: (info) => info.getValue<string>(), header: "타입" },
      { accessorKey: "nullable", cell: (info) => info.getValue<string>(), header: "Null 허용" },
      { accessorKey: "transform", cell: (info) => info.getValue<string>(), header: "변환식" },
    ],
    [],
  );

  return (
    <DataTable
      aria-label="출력 스키마 표"
      columns={columns}
      data={rows}
      emptyState={<span className="block px-4 py-8 text-center text-sm font-semibold text-slate-500">소스 연결과 스키마 추론이 완료되면 출력 스키마가 표시됩니다.</span>}
      enableSorting={false}
      pagination={false}
      role="region"
      tableClassName="schema-table review-schema-table"
      viewportClassName="review-schema-table-viewport rounded-none border-0"
    />
  );
}
