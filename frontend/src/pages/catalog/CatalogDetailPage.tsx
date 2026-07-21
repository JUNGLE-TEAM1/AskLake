import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import "@xyflow/react/dist/style.css";
import { AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCatalogDatasetRows } from "../../services/catalogApi";
import type { AuditResult, CatalogDataset, CatalogDatasetRowsResponse, DatasetMaterializationRun } from "../../types";
import { canDeleteDatasetMaterializationRun, permissionDeniedMessage } from "../../utils/permissions";
import { datasetStatusMeta } from "../../utils/statusMeta";
import { cn } from "@/lib/utils";
import { getCatalogFieldDescription } from "./catalogFieldDescriptions";
import { CatalogLineage, CatalogLineageMini } from "./CatalogLineage";
import { CatalogSchemaRow, CatalogSchemaTableVariant, formatCatalogModelExecution, formatRunCreatedAt, formatRunStorageSize, materializationRunPageSize, materializationRunStatusLabel } from "./catalogModel";
export function CatalogDetailPage({
  dataset,
  onAction,
  onBack,
  onLineage,
  onOpenSql,
  onRefresh,
}: {
  dataset: CatalogDataset;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onLineage: () => void;
  onOpenSql: () => void;
  onRefresh?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "schema" | "sample" | "lineage">("overview");

  const openLineage = () => {
    setActiveTab("lineage");
    onLineage();
  };

  const updateActiveTab = (nextTab: string) => {
    const normalizedTab = nextTab as typeof activeTab;
    if (normalizedTab === "lineage") onLineage();
    setActiveTab(normalizedTab);
  };

  return (
    <Tabs className="catalog-detail-page" value={activeTab} onValueChange={updateActiveTab}>
      <header className="catalog-detail-header">
        <Button className="job-detail-breadcrumb" type="button" onClick={onBack} size="sm" variant="link">검색/카탈로그 &gt; {dataset.name}</Button>
        <div className="catalog-detail-title-row">
          <div>
            <h1>{dataset.name}</h1>
            <div className="job-detail-meta">
              <DatasetStatusBadge dataset={dataset} />
              <Badge shape="compact" size="sm" variant="outline">{dataset.owner}</Badge>
              <Badge shape="compact" size="sm" variant="secondary">{dataset.layer} 레이어</Badge>
            </div>
          </div>
          <div className="job-detail-actions">
            <Button className="job-action-button primary" type="button" onClick={onOpenSql} size="sm" variant="primary"><ExternalLink size={14} /> SQL 분석에서 열기</Button>
            <Button className="job-action-button" type="button" onClick={openLineage} size="sm" variant="outline">리니지 보기</Button>
            <Button className="job-action-button" type="button" onClick={() => {
              onAction("catalog.dataset.refreshed", `/api/catalog/datasets/${dataset.id}`, dataset.id);
              onRefresh?.();
            }} size="sm" variant="outline">새로고침</Button>
          </div>
        </div>
        <TabsList aria-label="데이터셋 상세 탭" className="catalog-detail-tabs">
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="schema">스키마</TabsTrigger>
          <TabsTrigger value="sample">샘플 데이터</TabsTrigger>
          <TabsTrigger value="lineage">리니지</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent className="catalog-detail-tab-content" value="overview"><CatalogOverview dataset={dataset} onLineage={openLineage} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="schema"><CatalogSchema dataset={dataset} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="sample"><CatalogSample dataset={dataset} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="lineage"><CatalogLineage dataset={dataset} /></TabsContent>
    </Tabs>
  );
}

export function DatasetStatusBadge({ dataset, shape = "default" }: { dataset: CatalogDataset; shape?: BadgeProps["shape"] }) {
  const statusMeta = datasetStatusMeta[dataset.status];
  const statusTone = dataset.status === "available" ? "success" : dataset.status === "approval_required" ? "warning" : "outline";

  return (
    <>
      <StatusBadge shape={shape} size="sm" tone={statusTone}>{statusMeta.label}</StatusBadge>
    </>
  );
}

export function CatalogMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="catalog-mini-metric" size="sm" variant="muted">
      <span>{label}</span>
      <strong>{value}</strong>
    </Card>
  );
}

export function CatalogMaterializationRuns({
  canQueryDatasetForCurrentUser,
  dataset,
  onDelete,
  onPageChange,
  onSelectRun,
  page,
  selectedRunId,
}: {
  canQueryDatasetForCurrentUser: (dataset: CatalogDataset | null | undefined) => boolean;
  dataset: CatalogDataset;
  onDelete: (event: React.MouseEvent, dataset: CatalogDataset, runId: string) => void;
  onPageChange: (dataset: CatalogDataset, nextPage: number) => void;
  onSelectRun: (event: React.MouseEvent | React.KeyboardEvent, dataset: CatalogDataset, run: DatasetMaterializationRun) => void;
  page: number;
  selectedRunId: string | null;
}) {
  const runs = dataset.materializationRuns ?? [];
  const totalPages = Math.max(1, Math.ceil(runs.length / materializationRunPageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pageStartIndex = (currentPage - 1) * materializationRunPageSize;
  const visibleRuns = runs.slice(pageStartIndex, pageStartIndex + materializationRunPageSize);

  return (
    <div className="catalog-materialization-panel grid gap-3" onClick={(event) => event.stopPropagation()}>
      <p className="m-0 text-xs font-semibold leading-5 text-slate-500">
        SQL 분석에 사용할 데이터 저장 시점을 선택합니다.
      </p>
      {visibleRuns.length > 0 ? (
        <div className="grid gap-2">
          {visibleRuns.map((run) => {
            const isSelectable = run.status === "success" && canQueryDatasetForCurrentUser(dataset);
            const isSelected = run.runId === selectedRunId;
            const statusTone = run.status === "success" ? "success" : run.status === "failed" ? "danger" : run.status === "running" ? "default" : "muted";
            const textStructuringChecks = run.textStructuringExecution?.columns ?? run.textStructuring ?? [];
            const modelProvenance = textStructuringChecks.map((check) => {
              const targetColumn = check.targetColumn || check.target || check.output || "컬럼";
              const modelArtifact = check.selectedModelArtifact || check.modelArtifact;
              const execution = modelArtifact
                ? `${formatCatalogModelExecution(check.executionMode, check.fallbackUsed)} · ${modelArtifact}`
                : formatCatalogModelExecution(check.executionMode || check.runtimeStatus, check.fallbackUsed);
              return `${targetColumn}: ${execution}`;
            }).join(", ");
            const quarantineRows = Number(run.quarantine?.rows ?? 0);

            return (
            <Card
              aria-disabled={!isSelectable}
              aria-pressed={isSelected}
              className={cn(
                "grid gap-2 p-3 transition-colors",
                isSelectable ? "cursor-pointer hover:border-blue-300 hover:bg-blue-50/40" : "opacity-70",
                isSelected && "border-blue-500 bg-blue-50 ring-1 ring-blue-200",
              )}
              key={run.runId}
              role="button"
              size="none"
              tabIndex={isSelectable ? 0 : -1}
              title={isSelectable ? "SQL 분석 대상으로 선택" : !canQueryDatasetForCurrentUser(dataset) ? permissionDeniedMessage("데이터셋", "SQL 실행") : "성공한 데이터 버전만 SQL 분석 대상으로 선택할 수 있습니다."}
              onClick={(event) => onSelectRun(event, dataset, run)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRun(event, dataset, run);
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge shape="compact" size="sm" tone={statusTone}>{materializationRunStatusLabel(run.status)}</StatusBadge>
                <strong className="min-w-0 truncate" title={run.runId}>{run.runId}</strong>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      aria-label={`${run.runId} 데이터 버전 삭제`}
                      className="ml-auto"
                      disabled={!canDeleteDatasetMaterializationRun(dataset)}
                      shape="compact"
                      size="sm"
                      title={canDeleteDatasetMaterializationRun(dataset) ? "데이터 버전을 삭제합니다." : permissionDeniedMessage("데이터셋", "데이터 버전 삭제")}
                      type="button"
                      variant="ghost"
                      onClick={(event) => event.stopPropagation()}
                    >
                      삭제
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent onClick={(event) => event.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>데이터 버전을 삭제하시겠습니까?</AlertDialogTitle>
                      <AlertDialogDescription>{run.runId} 버전은 삭제 후 복구할 수 없습니다.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>취소</AlertDialogCancel>
                      <AlertDialogAction onClick={(event) => onDelete(event, dataset, run.runId)}>삭제</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                <span>{formatRunCreatedAt(run.createdAt)}</span>
                <span>{run.rowCount.toLocaleString()}행 · {formatRunStorageSize(run.storageSizeBytes)}</span>
                <span className="truncate sm:col-span-2" title={run.sourceLabel}>{run.sourceLabel}</span>
                {modelProvenance ? (
                  <span className="truncate font-semibold text-blue-700 sm:col-span-2" title={modelProvenance}>
                    모델 기반 변환 · {modelProvenance}
                  </span>
                ) : null}
                {quarantineRows > 0 ? (
                  <span className="truncate font-semibold text-amber-700 sm:col-span-2" title={run.quarantine?.path || undefined}>
                    검증 격리 · {quarantineRows.toLocaleString()}행
                  </span>
                ) : null}
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <Empty size="sm" variant="bordered">
          <EmptyHeader>
            <EmptyTitle>데이터 버전이 없습니다.</EmptyTitle>
            <EmptyDescription>데이터셋 생성 또는 append가 완료되면 여기에서 SQL 분석 대상을 선택할 수 있습니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {runs.length > materializationRunPageSize && (
        <PaginationBar
          currentPage={currentPage}
          onNext={() => onPageChange(dataset, currentPage + 1)}
          onPrevious={() => onPageChange(dataset, currentPage - 1)}
          rangeLabel={`${pageStartIndex + 1}-${Math.min(pageStartIndex + visibleRuns.length, runs.length)} / ${runs.length}`}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}

export function CatalogOverview({ dataset, onLineage }: { dataset: CatalogDataset; onLineage: () => void }) {
  return (
    <div className="catalog-detail-grid catalog-detail-grid-single">
      <Panel asChild className="catalog-overview-card">
        <section>
          <h2>리니지</h2>
          <CatalogLineageMini dataset={dataset} />
          <Button className="catalog-text-button" type="button" onClick={onLineage} size="sm" variant="link">전체 리니지 보기</Button>
        </section>
      </Panel>
    </div>
  );
}

export function CatalogSchema({ dataset }: { dataset: CatalogDataset }) {
  return (
    <Panel asChild className="catalog-table-card">
      <section>
        <div className="catalog-section-header">
          <h2>스키마</h2>
        </div>
        <CatalogSchemaTable dataset={dataset} />
      </section>
    </Panel>
  );
}

export function CatalogDatasetViewer({ dataset }: { dataset: CatalogDataset }) {
  return (
    <div className="catalog-dataset-viewer">
      <CatalogSchema dataset={dataset} />
    </div>
  );
}

export function CatalogSchemaTable({ dataset, maxRows, variant = "full" }: { dataset: CatalogDataset; maxRows?: number; variant?: CatalogSchemaTableVariant }) {
  const data = useMemo(
    () => {
      const firstSampleRow = dataset.sampleRows[0] ?? [];

      return dataset.schema.slice(0, maxRows ?? dataset.schema.length).map(([name, type], index) => {
        const sampleValue = firstSampleRow[index];

        return {
          description: getCatalogFieldDescription(dataset, name, type),
          id: `${name}-${index}`,
          name,
          sample: sampleValue === undefined || String(sampleValue).trim() === "" ? "-" : String(sampleValue),
          type,
        };
      });
    },
    [dataset.name, dataset.sampleRows, dataset.schema, maxRows],
  );
  const columns = useMemo<ColumnDef<CatalogSchemaRow>[]>(
    () => {
      const baseColumns: ColumnDef<CatalogSchemaRow>[] = [
        {
          accessorKey: "name",
          cell: (info) => <span title={info.getValue<string>()}>{info.getValue<string>()}</span>,
          enableSorting: variant !== "preview",
          header: "컬럼명",
          meta: {
            cellClassName: "catalog-schema-name-cell",
            widthClassName: variant === "preview" ? "w-[58%]" : "w-[28%]",
          } as DataTableColumnMeta,
        },
        {
          accessorKey: "type",
          cell: (info) => <Badge shape="compact" size="sm" variant="muted">{info.getValue<string>()}</Badge>,
          enableSorting: variant !== "preview",
          header: "타입",
          meta: {
            widthClassName: variant === "preview" ? "w-[42%]" : "w-[18%]",
          } as DataTableColumnMeta,
        },
      ];

      if (variant === "preview") return baseColumns;

      return [
        ...baseColumns,
        {
          accessorKey: "sample",
          cell: (info) => <span className="catalog-schema-sample-cell" title={info.getValue<string>()}>{info.getValue<string>()}</span>,
          enableSorting: true,
          header: "샘플",
          meta: {
            widthClassName: "w-[28%]",
          } as DataTableColumnMeta,
        },
        {
          accessorKey: "description",
          cell: (info) => <span title={info.getValue<string>()}>{info.getValue<string>()}</span>,
          enableSorting: true,
          header: "설명",
          meta: {
            cellClassName: "catalog-schema-description-cell",
            widthClassName: "w-[26%]",
          } as DataTableColumnMeta,
        },
      ];
    },
    [variant],
  );
  return (
    <DataTable
      className={variant === "preview" ? "catalog-schema-table-wrap preview" : "catalog-schema-table-wrap"}
      columns={columns}
      data={data}
      emptyState={{
        title: "스키마 컬럼이 없습니다.",
        description: "선택한 데이터셋에 표시할 컬럼 정보가 없습니다.",
      }}
      enableSorting={variant !== "preview"}
      getRowId={(row) => row.id}
      tableClassName={variant === "preview" ? "catalog-schema-preview" : "schema-table catalog-schema-table"}
      viewportClassName={variant === "preview" ? "catalog-schema-preview-viewport" : "catalog-schema-table-viewport"}
    />
  );
}

export function CatalogSample({ dataset }: { dataset: CatalogDataset }) {
  const pageSize = 100;
  const [offset, setOffset] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [rowsResult, setRowsResult] = useState<CatalogDatasetRowsResponse | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsErrorStatus, setRowsErrorStatus] = useState<number | null>(null);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [horizontalScrollPercent, setHorizontalScrollPercent] = useState(0);
  const fallbackColumns = dataset.schema.slice(0, 8).map(([name]) => name);
  const columns = rowsResult?.columns.length ? rowsResult.columns : fallbackColumns;
  const mayShowStoredPreview = rowsErrorStatus !== 403;
  const rows = rowsResult?.rows ?? (mayShowStoredPreview ? dataset.sampleRows.slice(0, pageSize) : []);
  const usingStoredPreview = rowsResult === null && rowsError !== null && mayShowStoredPreview;
  const pageUnavailable = rowsErrorStatus === 403;
  const displayOffset = usingStoredPreview || pageUnavailable ? 0 : offset;
  const totalRows = rowsResult?.rowCount ?? rows.length;
  const latestSuccessfulRun = useMemo(
    () => (dataset.materializationRuns ?? [])
      .filter((run) => run.status === "success")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null,
    [dataset.materializationRuns],
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoadingRows(true);
    setRowsError(null);
    setRowsErrorStatus(null);
    getCatalogDatasetRows(dataset.id, { limit: pageSize, offset })
      .then((result) => {
        if (!cancelled) setRowsResult(result);
      })
      .catch((error) => {
        if (cancelled) return;
        const errorStatus = typeof error === "object" && error && "status" in error
          ? Number((error as { status?: unknown }).status)
          : null;
        setRowsError(errorStatus === 403
          ? permissionDeniedMessage("데이터셋", "샘플 데이터 조회")
          : error instanceof Error ? error.message : "데이터셋 행을 불러오지 못했습니다.");
        setRowsErrorStatus(errorStatus);
        setRowsResult(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingRows(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset.id, offset, refreshVersion]);

  useEffect(() => {
    setOffset(0);
    setRowsResult(null);
    setRowsError(null);
    setRowsErrorStatus(null);
    setHorizontalScrollPercent(0);
  }, [dataset.id]);

  useEffect(() => {
    if (!rowsResult || rowsResult.rowCount === 0 || offset < rowsResult.rowCount) return;
    setOffset(Math.floor((rowsResult.rowCount - 1) / pageSize) * pageSize);
  }, [offset, rowsResult]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const updateScrollState = () => {
      const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      setHorizontalScrollPercent(nextMax > 0 ? (viewport.scrollLeft / nextMax) * 100 : 0);
    };
    const resizeObserver = new ResizeObserver(updateScrollState);

    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild);
    updateScrollState();

    return () => resizeObserver.disconnect();
  }, [dataset.id, rowsResult]);

  const updateHorizontalScroll = ([nextPercent]: number[]) => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = (nextPercent / 100) * nextMax;
    setHorizontalScrollPercent(nextPercent);
  };

  const nextOffset = displayOffset + pageSize;
  const previousOffset = Math.max(0, displayOffset - pageSize);
  const hasNext = rowsResult?.hasNext ?? false;
  const startLabel = totalRows === 0 ? 0 : displayOffset + 1;
  const endLabel = Math.min(displayOffset + rows.length, totalRows);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.floor(displayOffset / pageSize) + 1;
  const lastOffset = Math.max(0, (totalPages - 1) * pageSize);

  return (
    <Panel asChild className="catalog-table-card">
      <section>
        <div className="catalog-section-header catalog-sample-header">
          <div>
            <h2>샘플 데이터</h2>
            <span className="catalog-sample-version">
              {latestSuccessfulRun ? `최신 성공 버전 ${latestSuccessfulRun.runId}` : "현재 데이터셋"}
            </span>
          </div>
          <div className="catalog-sample-actions">
            <span>{isLoadingRows ? "불러오는 중..." : `${startLabel}-${endLabel} / ${totalRows.toLocaleString()}행`}</span>
            <Button
              aria-label="샘플 데이터 새로고침"
              disabled={isLoadingRows}
              shape="compact"
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setRefreshVersion((version) => version + 1)}
            >
              <RefreshCw data-icon="inline-start" /> 새로고침
            </Button>
          </div>
        </div>
        {rowsError ? (
          <Alert className="m-4" variant="destructive">
            <AlertCircle />
            <AlertTitle>{rowsErrorStatus === 403 ? "샘플 데이터 조회 권한이 없습니다." : "실제 데이터를 불러오지 못했습니다."}</AlertTitle>
            <AlertDescription>
              {rowsError}{rowsErrorStatus === 403 ? "" : " 저장된 미리보기 데이터를 표시합니다."}
            </AlertDescription>
          </Alert>
        ) : null}
        <Slider
          aria-label="샘플 데이터 가로 이동"
          className="catalog-sample-slider"
          max={100}
          min={0}
          step={1}
          value={[horizontalScrollPercent]}
          onValueChange={updateHorizontalScroll}
        />
        <ScrollArea
          className="catalog-sample-scroll"
          scrollbars="none"
          viewportProps={{
            onScroll: (event) => {
              const viewport = event.currentTarget;
              const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
              setHorizontalScrollPercent(nextMax > 0 ? (viewport.scrollLeft / nextMax) * 100 : 0);
            },
          }}
          viewportRef={scrollViewportRef}
        >
          <Table className="catalog-sample-table">
            <TableHeader>
              <TableRow>{columns.map((column, index) => <TableHead key={`${column}-${index}`}>{column}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`dataset-row-${displayOffset + rowIndex}`}>
                  {columns.map((_, cellIndex) => <TableCell key={`${displayOffset + rowIndex}-${cellIndex}`}>{row[cellIndex] ?? ""}</TableCell>)}
                </TableRow>
              ))}
              {!isLoadingRows && rows.length === 0 ? (
                <TableRow>
                  <TableCell className="h-24 text-center text-slate-500" colSpan={Math.max(columns.length, 1)}>
                    표시할 데이터 행이 없습니다.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </ScrollArea>
        <div className="catalog-sample-pagination">
          <Button
            disabled={displayOffset === 0 || isLoadingRows || usingStoredPreview || pageUnavailable}
            shape="compact"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setOffset(0)}
          >
            처음
          </Button>
          <PaginationBar
            className="catalog-pagination"
            currentPage={currentPage}
            nextDisabled={!hasNext || isLoadingRows || usingStoredPreview || pageUnavailable}
            onNext={() => setOffset(nextOffset)}
            onPrevious={() => setOffset(previousOffset)}
            previousDisabled={displayOffset === 0 || isLoadingRows || usingStoredPreview || pageUnavailable}
            rangeLabel={`${startLabel}-${endLabel} / ${totalRows.toLocaleString()}`}
            totalPages={totalPages}
          />
          <Button
            disabled={displayOffset >= lastOffset || isLoadingRows || usingStoredPreview || pageUnavailable}
            shape="compact"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setOffset(lastOffset)}
          >
            마지막
          </Button>
        </div>
      </section>
    </Panel>
  );
}
