import type { RefObject } from "react";
import {
  SQL_PAGE_PANEL_ICON_CLASS_NAME,
  SqlPageIcon as BarChart3,
  SqlPageIcon as PanelLeftClose,
  SqlPageIcon as Search,
  SqlPageIcon as Table2,
} from "./SqlPageIcon";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldTitle } from "@/components/ui/field";
import { FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CatalogDataset } from "../../types";
import styles from "./SqlAnalysisPage.module.css";
import { SqlChartConfigurator } from "./SqlChartConfigurator";
import { SqlDatasetTree } from "./SqlDatasetRow";
import type { SqlChartConfig, SqlChartSource } from "./SqlResultChart";

export type SqlContextPanelTab = "chart" | "tables";

type SqlDatasetContextPanelProps = {
  chartConfig: SqlChartConfig | null;
  chartSources: SqlChartSource[];
  contextListRef: RefObject<HTMLDivElement | null>;
  contextPageSize: number;
  contextPaginationRef: RefObject<HTMLDivElement | null>;
  contextPanelRef: RefObject<HTMLElement | null>;
  currentPage: number;
  datasetSearch: string;
  expandedDatasetId: string | null;
  filteredDatasetCount: number;
  onApplyChartConfig: (config: SqlChartConfig) => void;
  onCollapse: () => void;
  onDatasetSearchChange: (value: string) => void;
  onNextPage: () => void;
  onPreviousPage: () => void;
  onSelectDataset: (dataset: CatalogDataset) => void;
  onTabChange: (tab: SqlContextPanelTab) => void;
  onToggleDataset: (dataset: CatalogDataset) => void;
  pageDatasets: CatalogDataset[];
  rangeLabel: string;
  selectedDatasetIds: ReadonlySet<string>;
  tab: SqlContextPanelTab;
  totalPages: number;
};

export function SqlDatasetContextPanel({
  chartConfig,
  chartSources,
  contextListRef,
  contextPageSize,
  contextPaginationRef,
  contextPanelRef,
  currentPage,
  datasetSearch,
  expandedDatasetId,
  filteredDatasetCount,
  onApplyChartConfig,
  onCollapse,
  onDatasetSearchChange,
  onNextPage,
  onPreviousPage,
  onSelectDataset,
  onTabChange,
  onToggleDataset,
  pageDatasets,
  rangeLabel,
  selectedDatasetIds,
  tab,
  totalPages,
}: SqlDatasetContextPanelProps) {
  return (
    <Panel asChild>
      <aside className={styles.datasetPanel} ref={contextPanelRef}>
        <Tabs
          className="grid h-full min-h-0 grid-rows-[max-content_minmax(0,1fr)] gap-4"
          onValueChange={(value) => onTabChange(value as SqlContextPanelTab)}
          value={tab}
        >
          <div className="grid gap-4">
            <PanelHeader
              actions={(
                <Button type="button" onClick={onCollapse} aria-label="SQL 도구 접기" title="SQL 도구 접기" size="icon" variant="ghost">
                  <PanelLeftClose data-icon="inline-start" />
                </Button>
              )}
              className="min-h-0 p-0"
              icon={<Table2 size={16} />}
              iconClassName={SQL_PAGE_PANEL_ICON_CLASS_NAME}
              title="SQL 도구"
            />
            <TabsList className="grid w-full grid-cols-2" aria-label="SQL 도구 선택">
              <TabsTrigger value="tables"><Table2 /> 분석 테이블</TabsTrigger>
              <TabsTrigger value="chart"><BarChart3 /> 차트 생성하기</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent className="mt-0 grid min-h-0 min-w-0 grid-rows-[max-content_minmax(0,1fr)] gap-3 overflow-hidden" value="tables">
            <FilterToolbarSearch icon={<Search size={15} />} size="compact">
              <FilterToolbarInput
                aria-label="분석 테이블 검색"
                className="text-xs font-bold"
                value={datasetSearch}
                onChange={(event) => onDatasetSearchChange(event.target.value)}
                placeholder="데이터셋, 컬럼, 태그 검색"
                type="search"
              />
            </FilterToolbarSearch>
            <section className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)_max-content] gap-2">
              <FieldTitle>데이터셋</FieldTitle>
              <div className="relative min-h-0 overflow-hidden">
                <Panel asChild>
                  <div className="absolute inset-0 min-h-0 overflow-hidden">
                    <div className="h-full min-w-0 pr-1" ref={contextListRef}>
                      <SqlDatasetTree
                        datasets={pageDatasets}
                        expandedDatasetId={expandedDatasetId}
                        onSelect={onSelectDataset}
                        onToggle={onToggleDataset}
                        selectedDatasetIds={selectedDatasetIds}
                      />
                      {filteredDatasetCount === 0 && (
                        <Empty size="sm" variant="bordered">
                          <EmptyHeader>
                            <EmptyTitle>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</EmptyTitle>
                            <EmptyDescription>{datasetSearch.trim() ? "다른 검색어를 입력해 주세요." : "SQL에 사용할 테이블이 없습니다."}</EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      )}
                    </div>
                  </div>
                </Panel>
              </div>
              {filteredDatasetCount > contextPageSize && (
                <PaginationBar
                  aria-label="테이블 검색 결과 페이지"
                  buttonSize="sm"
                  currentPage={currentPage}
                  onNext={onNextPage}
                  onPrevious={onPreviousPage}
                  rangeLabel={rangeLabel}
                  ref={contextPaginationRef}
                  totalPages={totalPages}
                />
              )}
            </section>
          </TabsContent>

          <TabsContent className={`${styles.chartConfigurator} mt-0 min-w-0`} value="chart">
            <SqlChartConfigurator
              initialConfig={chartConfig}
              onApply={onApplyChartConfig}
              sources={chartSources}
            />
          </TabsContent>
        </Tabs>
      </aside>
    </Panel>
  );
}
