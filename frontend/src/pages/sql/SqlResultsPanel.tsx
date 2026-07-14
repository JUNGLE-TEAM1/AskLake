import type { ReactNode } from "react";
import {
  SQL_PAGE_PANEL_ICON_CLASS_NAME,
  SqlPageIcon as Activity,
  SqlPageIcon as BarChart3,
  SqlPageIcon as Database,
  SqlPageIcon as Download,
  SqlPageIcon as Maximize2,
  SqlPageIcon as RotateCcw,
  SqlPageIcon as Table2,
} from "./SqlPageIcon";

import { ActionGroup } from "@/components/ui/action-group";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SqlResultDraft } from "../../types";
import styles from "./SqlAnalysisPage.module.css";
import { SqlPreviewTable } from "./SqlPreviewTable";
import { SqlResultChart, type SqlChartConfig, type SqlChartSource } from "./SqlResultChart";

export type SqlResultView = "chart" | "execution" | "table";

export type SqlRemoteResultPagination = {
  currentPage: number;
  nextDisabled: boolean;
  onNext: () => void;
  onPrevious: () => void;
  pending?: boolean;
  previousDisabled: boolean;
  rangeLabel: string;
  totalPages?: number | null;
};

type SqlResultsPanelProps = {
  activeChartSource?: SqlChartSource;
  baseDatasetSelected: boolean;
  chartConfig: SqlChartConfig | null;
  dialogResultDraft: SqlResultDraft | null;
  dialogOpen: boolean;
  downloadDisabled?: boolean;
  executionEnabled?: boolean;
  executionInfo?: ReactNode;
  jobCreationDisabled?: boolean;
  pageError: string | null;
  pagePending: boolean;
  onDialogOpenChange: (open: boolean) => void;
  onDownloadCsv: () => void;
  onOpenJobWizard: () => void;
  onPageChange: (offset: number) => void;
  onPageRetry?: () => void;
  onResultViewChange: (view: SqlResultView) => void;
  remotePagination?: SqlRemoteResultPagination;
  resultDraft: SqlResultDraft | null;
  resultView: SqlResultView;
};

function SqlChartEmptyState() {
  return (
    <Empty className={styles.resultViewEmpty} size="sm" variant="bordered">
      <EmptyHeader>
        <EmptyTitle>아직 생성된 차트가 없습니다.</EmptyTitle>
        <EmptyDescription>왼쪽 차트 생성하기에서 위젯을 설정하고 차트를 생성해 주세요.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SqlResultContent({
  activeChartSource,
  chartConfig,
  resultDraft,
  resultView,
  isLoading = false,
  executionInfo,
}: Pick<SqlResultsPanelProps, "activeChartSource" | "chartConfig" | "executionInfo" | "resultDraft" | "resultView"> & { isLoading?: boolean }) {
  if (resultView === "execution") return executionInfo;
  if (!resultDraft) return null;
  if (resultView === "table") return <SqlPreviewTable isLoading={isLoading} resultDraft={resultDraft} />;
  if (chartConfig && activeChartSource) {
    return <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />;
  }
  return <SqlChartEmptyState />;
}

function SqlRemotePaginationControls({ pagination }: { pagination: SqlRemoteResultPagination }) {
  return (
    <div aria-label="Trino 결과 페이지 탐색" className={styles.resultRemotePagination}>
      <strong>{pagination.rangeLabel}</strong>
      <div className={styles.resultPaginationActions}>
        <Button
          disabled={pagination.previousDisabled || pagination.pending}
          onClick={pagination.onPrevious}
          size="sm"
          type="button"
          variant="outline"
        >
          이전
        </Button>
        <span>
          {pagination.currentPage}
          {pagination.totalPages ? ` / ${pagination.totalPages}` : ""}
        </span>
        <Button
          disabled={pagination.nextDisabled || pagination.pending}
          onClick={pagination.onNext}
          size="sm"
          type="button"
          variant="outline"
        >
          다음
        </Button>
      </div>
    </div>
  );
}

function SqlResultPageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.resultPageError} role="alert">
      <span>{message}</span>
      {onRetry ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <RotateCcw data-icon="inline-start" /> 다시 시도
        </Button>
      ) : null}
    </div>
  );
}

function getResultRange(resultDraft: SqlResultDraft) {
  const limit = resultDraft.pageLimit ?? resultDraft.previewLimit ?? 100;
  const offset = resultDraft.pageOffset ?? 0;
  const total = resultDraft.rowCount;
  return {
    currentPage: total === 0 ? 1 : Math.floor(offset / limit) + 1,
    end: total === 0 ? 0 : Math.min(offset + resultDraft.rows.length, total),
    limit,
    offset,
    start: total === 0 ? 0 : offset + 1,
    total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  };
}

export function SqlResultsPanel({
  activeChartSource,
  baseDatasetSelected,
  chartConfig,
  dialogResultDraft,
  dialogOpen,
  downloadDisabled = false,
  executionEnabled = false,
  executionInfo,
  jobCreationDisabled = false,
  pageError,
  pagePending,
  onDialogOpenChange,
  onDownloadCsv,
  onOpenJobWizard,
  onPageChange,
  onPageRetry,
  onResultViewChange,
  remotePagination,
  resultDraft,
  resultView,
}: SqlResultsPanelProps) {
  const previewRange = resultDraft ? getResultRange(resultDraft) : null;
  const dialogDraft = dialogResultDraft ?? resultDraft;
  const dialogRange = dialogDraft ? getResultRange(dialogDraft) : null;
  const showResultWorkspace = Boolean(resultDraft || executionEnabled);
  const isTableView = resultView === "table";
  const isCompactTableResult = Boolean(isTableView && resultDraft && resultDraft.rows.length <= 8);
  const resultScrollbars = resultView === "execution" || (isCompactTableResult && resultDraft && resultDraft.columns.length <= 4)
    ? "vertical"
    : "both";

  return (
    <>
      <Panel
        className={`${styles.resultPanel} ${showResultWorkspace ? styles.resultPanelActive : ""} ${isCompactTableResult ? styles.resultPanelCompact : ""} grid gap-0 p-0`}
        overflow={isCompactTableResult ? "visible" : "hidden"}
      >
        {showResultWorkspace ? (
          <div className={styles.resultWorkspace}>
            <div className={styles.resultToolbar}>
              <ToggleGroup
                aria-label="SQL 결과 보기"
                onValueChange={(value) => value && onResultViewChange(value as SqlResultView)}
                type="single"
                value={resultView}
              >
                <ToggleGroupItem aria-label="차트 보기" disabled={!resultDraft} size="sm" value="chart">
                  <BarChart3 /> 차트 보기
                </ToggleGroupItem>
                <ToggleGroupItem aria-label="데이터 미리보기" disabled={!resultDraft} size="sm" value="table">
                  <Table2 /> 데이터 미리보기
                </ToggleGroupItem>
                {executionEnabled ? (
                  <ToggleGroupItem aria-label="실행 정보" size="sm" value="execution">
                    <Activity /> 실행 정보
                  </ToggleGroupItem>
                ) : null}
              </ToggleGroup>
              {previewRange && resultView === "table" ? (
                <strong className={styles.resultRange}>
                  {remotePagination?.rangeLabel ?? `${previewRange.start.toLocaleString()}–${previewRange.end.toLocaleString()} / ${previewRange.total.toLocaleString()}행`}
                </strong>
              ) : null}
              {resultDraft && resultView !== "execution" ? (
                <ActionGroup density="compact" wrap="wrap">
                  <Button disabled={downloadDisabled} type="button" onClick={onDownloadCsv} size="sm" variant="outline">
                    <Download data-icon="inline-start" /> CSV 다운로드
                  </Button>
                  <Button disabled={jobCreationDisabled} type="button" onClick={onOpenJobWizard} size="sm" variant="outline">
                    <Database data-icon="inline-start" /> 처리 Job 생성
                  </Button>
                  <Button type="button" onClick={() => onDialogOpenChange(true)} size="sm" variant="outline">
                    <Maximize2 data-icon="inline-start" /> 전체 보기
                  </Button>
                </ActionGroup>
              ) : null}
            </div>
            <div className={`${styles.resultBody} ${isCompactTableResult ? styles.resultBodyCompact : ""}`}>
              <ScrollArea className={styles.resultScroll} scrollbars={resultScrollbars} type="always">
                <SqlResultContent
                  activeChartSource={activeChartSource}
                  chartConfig={chartConfig}
                  executionInfo={executionInfo}
                  resultDraft={resultDraft}
                  resultView={resultView}
                />
              </ScrollArea>
              {resultDraft && resultView === "table" && remotePagination ? <SqlRemotePaginationControls pagination={remotePagination} /> : null}
              {resultDraft && resultView === "table" && remotePagination && pageError ? (
                <SqlResultPageError message={pageError} onRetry={onPageRetry} />
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <PanelHeader
              icon={<Table2 size={16} />}
              iconClassName={SQL_PAGE_PANEL_ICON_CLASS_NAME}
              iconVariant="outline"
              size="section"
              title="결과 대기 중"
            />
            <div className="grid min-h-0 p-5 pt-4">
              <Empty className={styles.resultEmpty} size="sm" variant="bordered">
                <EmptyHeader>
                  <EmptyTitle>아직 결과가 없습니다.</EmptyTitle>
                  <EmptyDescription>
                    {baseDatasetSelected ? "SQL을 실행하면 Preview 결과가 여기에 표시됩니다." : "먼저 분석 테이블에서 데이터셋을 선택해 주세요."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          </>
        )}
      </Panel>

      {resultDraft && dialogDraft && dialogRange && resultView !== "execution" && (
        <Dialog onOpenChange={onDialogOpenChange} open={dialogOpen}>
          <DialogContent className="grid h-[min(900px,calc(100vh-2rem))] w-[min(1440px,calc(100vw-2rem))] max-w-none grid-rows-[max-content_minmax(0,1fr)] overflow-hidden">
            <DialogHeader>
              <DialogTitle>SQL 결과 전체 보기</DialogTitle>
              <DialogDescription>
                {dialogRange.start.toLocaleString()}–{dialogRange.end.toLocaleString()} / {dialogRange.total.toLocaleString()}행 · {dialogDraft.columns.length}컬럼 · {resultView === "chart" ? "차트" : "표"} 보기
              </DialogDescription>
            </DialogHeader>
            <div className={styles.resultDialogBody}>
              {resultView === "table" ? (
                <>
                  <div className={styles.resultDialogControls}>
                    {remotePagination ? (
                      <SqlRemotePaginationControls pagination={remotePagination} />
                    ) : <div className={styles.resultPagination} aria-label="SQL 결과 페이지 탐색">
                      <strong>
                        {dialogRange.start.toLocaleString()}–{dialogRange.end.toLocaleString()} / {dialogRange.total.toLocaleString()}행
                      </strong>
                      <div className={styles.resultPaginationActions}>
                      <Button
                        disabled={dialogRange.currentPage <= 1 || pagePending}
                        onClick={() => onPageChange(0)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        처음
                      </Button>
                      <Button
                        disabled={dialogRange.currentPage <= 1 || pagePending}
                        onClick={() => onPageChange(Math.max(0, dialogRange.offset - dialogRange.limit))}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        이전
                      </Button>
                      <NativeSelect
                        aria-label="SQL 결과 페이지"
                        disabled={pagePending}
                        onChange={(event) => onPageChange((Number(event.target.value) - 1) * dialogRange.limit)}
                        size="sm"
                        value={dialogRange.currentPage}
                        wrapperClassName="w-[112px]"
                      >
                        {Array.from({ length: dialogRange.totalPages }, (_, index) => (
                          <option key={index + 1} value={index + 1}>{index + 1} / {dialogRange.totalPages}</option>
                        ))}
                      </NativeSelect>
                      <Button
                        disabled={dialogRange.currentPage >= dialogRange.totalPages || pagePending}
                        onClick={() => onPageChange(dialogRange.offset + dialogRange.limit)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        다음
                      </Button>
                      <Button
                        disabled={dialogRange.currentPage >= dialogRange.totalPages || pagePending}
                        onClick={() => onPageChange((dialogRange.totalPages - 1) * dialogRange.limit)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        마지막
                      </Button>
                      </div>
                    </div>}
                    {pageError ? <SqlResultPageError message={pageError} onRetry={remotePagination ? onPageRetry : undefined} /> : null}
                  </div>
                  <ScrollArea className="min-h-0" scrollbars="both" type="always">
                    <div className="min-w-0 px-4 pb-4 pt-6">
                      <SqlResultContent
                        activeChartSource={activeChartSource}
                        chartConfig={chartConfig}
                        executionInfo={executionInfo}
                        isLoading={pagePending}
                        resultDraft={dialogDraft}
                        resultView={resultView}
                      />
                    </div>
                  </ScrollArea>
                </>
              ) : (
                <ScrollArea className="row-span-2 min-h-0" scrollbars="both" type="always">
                  <SqlResultContent
                    activeChartSource={activeChartSource}
                    chartConfig={chartConfig}
                    executionInfo={executionInfo}
                    resultDraft={dialogDraft}
                    resultView={resultView}
                  />
                </ScrollArea>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
