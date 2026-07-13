import type { ReactNode } from "react";
import { BarChart3, Database, Download, Maximize2, Table2 } from "lucide-react";

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
import { Panel } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SqlResultDraft } from "../../types";
import styles from "./SqlAnalysisPage.module.css";
import {
  SqlPreviewTable,
  type SqlPreviewRemotePagination,
} from "./SqlPreviewTable";
import { SqlResultChart, type SqlChartConfig, type SqlChartSource } from "./SqlResultChart";

export type SqlResultView = "chart" | "table";

type SqlResultsPanelProps = {
  activeChartSource?: SqlChartSource;
  baseDatasetSelected: boolean;
  chartConfig: SqlChartConfig | null;
  dialogOpen: boolean;
  emptyStateContent?: ReactNode;
  onDialogOpenChange: (open: boolean) => void;
  onDownloadCsv: () => void;
  onOpenJobWizard: () => void;
  onResultViewChange: (view: SqlResultView) => void;
  progressContent?: ReactNode;
  remotePagination?: SqlPreviewRemotePagination;
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
  remotePagination,
  resultDraft,
  resultView,
}: Pick<SqlResultsPanelProps, "activeChartSource" | "chartConfig" | "remotePagination" | "resultDraft" | "resultView">) {
  if (!resultDraft) return null;
  if (resultView === "table") {
    return (
      <SqlPreviewTable
        remotePagination={remotePagination}
        resultDraft={resultDraft}
      />
    );
  }
  if (chartConfig && activeChartSource) {
    return <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />;
  }
  return <SqlChartEmptyState />;
}

export function SqlResultsPanel({
  activeChartSource,
  baseDatasetSelected,
  chartConfig,
  dialogOpen,
  emptyStateContent,
  onDialogOpenChange,
  onDownloadCsv,
  onOpenJobWizard,
  onResultViewChange,
  progressContent,
  remotePagination,
  resultDraft,
  resultView,
}: SqlResultsPanelProps) {
  const resultToolbar = (
    <div className={styles.resultToolbar}>
      <ToggleGroup
        aria-label="SQL 결과 보기"
        onValueChange={(value) => value && onResultViewChange(value as SqlResultView)}
        type="single"
        value={resultView}
      >
        <ToggleGroupItem
          aria-label="차트 보기"
          className="data-[state=on]:ring-2 data-[state=on]:ring-blue-500 data-[state=on]:ring-offset-2"
          size="sm"
          value="chart"
        >
          <BarChart3 /> 차트 보기
        </ToggleGroupItem>
        <ToggleGroupItem
          aria-label="데이터 미리보기"
          className="data-[state=on]:ring-2 data-[state=on]:ring-blue-500 data-[state=on]:ring-offset-2"
          size="sm"
          value="table"
        >
          <Table2 /> 데이터 미리보기
        </ToggleGroupItem>
      </ToggleGroup>
      <ActionGroup density="compact" wrap="wrap">
        <Button type="button" onClick={onDownloadCsv} size="sm" variant="outline">
          <Download data-icon="inline-start" /> CSV 다운로드
        </Button>
        <Button type="button" onClick={onOpenJobWizard} size="sm" variant="outline">
          <Database data-icon="inline-start" /> 처리 Job 생성
        </Button>
        <Button type="button" onClick={() => onDialogOpenChange(true)} size="sm" variant="outline">
          <Maximize2 data-icon="inline-start" /> 전체 보기
        </Button>
      </ActionGroup>
    </div>
  );

  return (
    <>
      <Panel className={`${styles.resultPanel} grid gap-4 p-5`}>
        {resultDraft ? (
          <>
            {progressContent ? (
              <div className={styles.resultHeaderStack}>
                {progressContent}
                {resultToolbar}
              </div>
            ) : resultToolbar}
            <ScrollArea
              className={styles.resultScroll}
              data-sql-result-scroll="main"
              scrollbars="both"
              type="auto"
            >
              <SqlResultContent
                activeChartSource={activeChartSource}
                chartConfig={chartConfig}
                remotePagination={remotePagination}
                resultDraft={resultDraft}
                resultView={resultView}
              />
            </ScrollArea>
          </>
        ) : (
          <>
            {progressContent}
            {emptyStateContent ?? (
              <Empty className={styles.resultEmpty} size="sm" variant="bordered">
                <EmptyHeader>
                  <EmptyTitle>아직 결과가 없습니다.</EmptyTitle>
                  <EmptyDescription>
                    {baseDatasetSelected ? "SQL을 실행하면 Preview 결과가 여기에 표시됩니다." : "먼저 분석 테이블에서 데이터셋을 선택해 주세요."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </>
        )}
      </Panel>

      {resultDraft && (
        <Dialog onOpenChange={onDialogOpenChange} open={dialogOpen}>
          <DialogContent className="grid h-[min(900px,calc(100vh-2rem))] w-[min(1440px,calc(100vw-2rem))] max-w-none grid-rows-[max-content_minmax(0,1fr)] overflow-hidden">
            <DialogHeader>
              <DialogTitle>SQL 결과 전체 보기</DialogTitle>
              <DialogDescription>
                {resultDraft.rows.length}/{resultDraft.rowCount}행 · {resultDraft.columns.length}컬럼 · {resultView === "chart" ? "차트" : "표"} 보기
              </DialogDescription>
            </DialogHeader>
            <ScrollArea
              className="min-h-0"
              data-sql-result-scroll="dialog"
              scrollbars="both"
              type="auto"
            >
              {resultView === "table" ? (
                <div className="min-w-0 px-4 pb-4 pt-6">
                  <SqlResultContent
                    activeChartSource={activeChartSource}
                    chartConfig={chartConfig}
                    remotePagination={remotePagination}
                    resultDraft={resultDraft}
                    resultView={resultView}
                  />
                </div>
              ) : (
                <SqlResultContent
                  activeChartSource={activeChartSource}
                  chartConfig={chartConfig}
                  remotePagination={remotePagination}
                  resultDraft={resultDraft}
                  resultView={resultView}
                />
              )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
