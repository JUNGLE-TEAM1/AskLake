import type React from "react";
import "@xyflow/react/dist/style.css";
import { AlertCircle, ArrowUpDown, BookOpen, Database, ExternalLink, Filter, LayoutGrid, PanelRight, Pin, Star, Search, Share2, TerminalSquare, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/ui/empty";
import { FilterToolbar, FilterToolbarActions, FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AuditResult, CatalogDataset, CatalogDatasetDeletionImpact } from "../../types";
import { permissionDeniedMessage } from "../../utils/permissions";
import { cn } from "@/lib/utils";
import { type CatalogSortMode, type CatalogStatusFilter, catalogSortOptions, catalogStatusFilterOptions, formatCatalogDateTime } from "./catalogModel";
import { CatalogDatasetViewer, CatalogMiniMetric, CatalogSchemaTable, DatasetStatusBadge } from "./CatalogDetailPage";
import { CatalogLineage } from "./CatalogLineage";
import { useCatalogExplorerState } from "./useCatalogExplorerState";
import { CatalogDatasetDeleteAction } from "./CatalogDatasetDeleteAction";
export function CatalogPage({
  datasetDeletionPendingById,
  datasets,
  error = null,
  loading = false,
  onAction,
  onDeleteDataset,
  onLoadDeletionImpact,
  onOpenSql,
  onRefresh,
  selectedDataset,
  viewSwitcher,
}: {
  datasetDeletionPendingById: Record<string, boolean>;
  datasets: CatalogDataset[];
  error?: string | null;
  loading?: boolean;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDeleteDataset: (datasetId: string) => Promise<boolean>;
  onLoadDeletionImpact: (datasetId: string) => Promise<CatalogDatasetDeletionImpact>;
  onOpenSql: (dataset: CatalogDataset) => void;
  onRefresh?: () => void;
  selectedDataset: CatalogDataset;
  viewSwitcher?: React.ReactNode;
}) {
  const {
    activeModal,
    activeStatusFilter,
    canQueryCurrentDataset,
    currentCatalogPage,
    currentPageEndIndex,
    currentPageStartIndex,
    filteredDatasets,
    handleSearchSubmit,
    hasCatalogResults,
    isPreviewPinned,
    mobilePreviewOpen,
    openPreviewModal,
    openSelectedSqlDataset,
    paginatedDatasets,
    pinnedDatasetIds,
    previewDataset,
    previewDetailError,
    previewDetailLoading,
    searchText,
    selectPreviewDataset,
    selectedSqlDatasetId,
    setActiveModal,
    setMobilePreviewOpen,
    setSearchText,
    sortMode,
    togglePinnedDataset,
    totalCatalogPages,
    updateResultPage,
    updateSortMode,
    updateStatusFilter,
  } = useCatalogExplorerState({ datasets, onAction, onOpenSql, selectedDataset });

  const renderPreviewContent = (fromMobileSheet = false) => (
    <>
      <PanelHeader
        actions={(
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={isPreviewPinned ? "데이터셋 고정 해제" : "데이터셋 상단 고정"}
                aria-pressed={isPreviewPinned}
                shape="compact"
                type="button"
                size="iconSm"
                variant={isPreviewPinned ? "subtle" : "ghost"}
                onClick={togglePinnedDataset}
              >
                <Star fill={isPreviewPinned ? "currentColor" : "none"} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isPreviewPinned ? "상단 고정 해제" : "상단에 고정"}</TooltipContent>
          </Tooltip>
        )}
        bordered={false}
        className="catalog-preview-title"
        icon={<Database size={16} />}
        iconVariant="outline"
        title={(
          <Tooltip>
            <TooltipTrigger asChild><span className="block min-w-0 truncate">{previewDataset.name}</span></TooltipTrigger>
            <TooltipContent>{previewDataset.name}</TooltipContent>
          </Tooltip>
        )}
      />
      <Separator />
      <ScrollArea className="catalog-preview-scroll" type="auto">
        <div className="catalog-preview-body">
          {previewDetailError ? (
            <Alert className="catalog-preview-detail-error" variant="destructive">
              <AlertCircle />
              <AlertTitle>기본 정보를 불러오지 못했습니다.</AlertTitle>
              <AlertDescription>{previewDetailError}</AlertDescription>
            </Alert>
          ) : null}
          <Accordion className="catalog-preview-accordion" type="multiple">
            <AccordionItem value="overview">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><LayoutGrid /> 기본 정보</span>
              </AccordionTrigger>
              <AccordionContent>
                <div aria-busy={previewDetailLoading} className="catalog-overview-metrics catalog-preview-metrics">
                  <CatalogMiniMetric label="품질 지표" value={previewDataset.quality} />
                  <CatalogMiniMetric label="최근 갱신 일시" value={formatCatalogDateTime(previewDataset.lastUpdated)} />
                  <CatalogMiniMetric label="데이터 담당자" value={previewDataset.owner} />
                  <CatalogMiniMetric label="행 수" value={previewDataset.rows} />
                  <CatalogMiniMetric label="파일 크기" value={previewDataset.size} />
                  <CatalogMiniMetric label="갱신 예정 일시" value={previewDataset.nextRefresh} />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="schema">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><TerminalSquare /> 스키마 미리보기</span>
              </AccordionTrigger>
              <AccordionContent className="catalog-preview-accordion-content">
                <CatalogSchemaTable dataset={previewDataset} maxRows={5} variant="preview" />
                <Button className="catalog-text-button" type="button" onClick={() => openPreviewModal("schema", fromMobileSheet)} size="sm" variant="link">전체 스키마 상세 보기</Button>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="lineage">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><Share2 /> 리니지</span>
              </AccordionTrigger>
              <AccordionContent>
                <Button className="catalog-wide-button" shape="compact" size="sm" type="button" variant="outline" onClick={() => openPreviewModal("lineage", fromMobileSheet)}>
                  <Share2 data-icon="inline-start" /> 전체 리니지 보기
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          <Button
            className="catalog-wide-button"
            disabled={selectedSqlDatasetId !== previewDataset.id || !canQueryCurrentDataset(previewDataset)}
            shape="compact"
            size="sm"
            title={!canQueryCurrentDataset(previewDataset)
              ? permissionDeniedMessage("데이터셋", "SQL 실행")
              : selectedSqlDatasetId === previewDataset.id
                ? "선택한 데이터셋을 SQL 분석에서 엽니다."
                : "왼쪽 목록에서 데이터셋을 선택해 주세요."}
            type="button"
            variant="outline"
            onClick={openSelectedSqlDataset}
          >
            <ExternalLink data-icon="inline-start" /> SQL 분석에서 열기
          </Button>
        </div>
      </ScrollArea>
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
    <div className="catalog-page">
      {error ? (
        <Alert className="border-red-200 bg-red-50 text-red-800" variant="destructive">
          <AlertCircle />
          <AlertTitle>카탈로그를 불러오지 못했습니다.</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="catalog-content-grid">
        <div className="catalog-main">
          {hasCatalogResults && (
            <Sheet open={mobilePreviewOpen} onOpenChange={setMobilePreviewOpen}>
              <SheetTrigger asChild>
                <Button className="catalog-preview-mobile-trigger" shape="compact" type="button" variant="outline">
                  <PanelRight data-icon="inline-start" /> 데이터셋 미리보기
                </Button>
              </SheetTrigger>
              <SheetContent className="catalog-preview-sheet" closeLabel="미리보기 닫기" side="right">
                <SheetHeader className="sr-only">
                  <SheetTitle>{previewDataset.name} 미리보기</SheetTitle>
                  <SheetDescription>데이터셋 정보와 빠른 작업</SheetDescription>
                </SheetHeader>
                {renderPreviewContent(true)}
              </SheetContent>
            </Sheet>
          )}

          <Panel className="catalog-results-section">
            <div className="catalog-results-header">
              <PanelHeader
                actions={viewSwitcher}
                bordered={false}
                icon={<BookOpen size={16} />}
                iconVariant="outline"
                size="section"
                title="카탈로그 목록"
              />
              <FilterToolbar className="py-3" layout="actions">
                <FilterToolbarSearch icon={<Search size={18} />}>
                  <FilterToolbarInput
                    aria-label="카탈로그 검색"
                    onChange={(event) => setSearchText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleSearchSubmit();
                      }
                    }}
                    placeholder="테이블명, 컬럼명 또는 업무 키워드로 검색하세요..."
                    type="search"
                    value={searchText}
                  />
                </FilterToolbarSearch>
                <FilterToolbarActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="상태 필터"
                        className="h-9 justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        상태
                        <Filter className="size-[18px]" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-44">
                      <DropdownMenuLabel>상태 필터</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup value={activeStatusFilter} onValueChange={(value) => updateStatusFilter(value as CatalogStatusFilter)}>
                        {catalogStatusFilterOptions.map((option) => (
                          <DropdownMenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu onOpenChange={(open) => open && onAction("catalog.sort_opened", "/api/catalog/search/sort", "catalog-sort")}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="정렬 기준"
                        className="h-9 justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        정렬
                        <ArrowUpDown className="size-[18px]" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuLabel>정렬 기준</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup value={sortMode} onValueChange={(value) => updateSortMode(value as CatalogSortMode)}>
                        {catalogSortOptions.map((option) => (
                          <DropdownMenuRadioItem key={option.mode} value={option.mode}>{option.label}</DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </FilterToolbarActions>
              </FilterToolbar>
            </div>

            <div className="catalog-result-list">
                {loading ? Array.from({ length: 3 }, (_, index) => (
                  <Card className="catalog-result-card flex items-center gap-3 p-4" key={`catalog-skeleton-${index}`} size="none">
                    <Skeleton className="h-5 w-2/5" />
                    <Skeleton className="ml-auto size-8" />
                  </Card>
                )) : paginatedDatasets.map((dataset) => {
                const isPinned = pinnedDatasetIds.includes(dataset.id);
                const isActive = dataset.id === previewDataset.id;
                return (
                  <div className="catalog-result-item" key={`${dataset.id}:${dataset.name}`}>
                    <Card className={cn("catalog-result-card", isActive && "active", isPinned && "pinned")} size="none">
                      <Button
                        aria-pressed={isActive}
                        className="catalog-result-select"
                        shape="compact"
                        size="content"
                        type="button"
                        variant="ghost"
                        onClick={() => selectPreviewDataset(dataset)}
                        title="데이터셋 선택"
                      >
                        <div className="catalog-result-summary">
                          <div className="catalog-result-title">
                            <div className="catalog-result-mainline">
                              <div className="catalog-result-heading">
                                <Tooltip>
                                  <TooltipTrigger asChild><strong className="truncate" title={undefined}>{dataset.name}</strong></TooltipTrigger>
                                  <TooltipContent>{dataset.name}</TooltipContent>
                                </Tooltip>
                                <DatasetStatusBadge dataset={dataset} shape="compact" />
                                {isPinned && (
                                  <Badge className="catalog-result-pin-badge" aria-label="상단 고정된 데이터셋" shape="compact" size="sm">
                                    <Pin />
                                    고정됨
                                  </Badge>
                                )}
                              </div>
                            </div>
                            {dataset.tags.length > 0 ? (
                              <span className="catalog-result-tags" title={dataset.tags.join(" · ")}>{dataset.tags.join(" · ")}</span>
                            ) : null}
                          </div>
                        </div>
                      </Button>
                      <CatalogDatasetDeleteAction
                        dataset={dataset}
                        onAction={onAction}
                        onDeleteDataset={onDeleteDataset}
                        onLoadDeletionImpact={onLoadDeletionImpact}
                        pending={Boolean(datasetDeletionPendingById[dataset.id])}
                      />
                    </Card>
                  </div>
                );
                })}
                {!loading && !hasCatalogResults && (
                  <Empty className="catalog-empty-state" size="sm" variant="bordered">
                    <EmptyIcon><Search /></EmptyIcon>
                    <EmptyHeader>
                      <EmptyTitle>검색 결과가 없습니다.</EmptyTitle>
                      <EmptyDescription>검색어, 태그, 상태 필터를 조정해 다시 확인하세요.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
            </div>

            {!loading && hasCatalogResults && (
              <PaginationBar
                aria-label="검색 결과 페이지"
                className="catalog-pagination"
                currentPage={currentCatalogPage}
                onNext={() => updateResultPage(currentCatalogPage + 1)}
                onPrevious={() => updateResultPage(currentCatalogPage - 1)}
                rangeLabel={`${currentPageStartIndex + 1}-${currentPageEndIndex} / ${filteredDatasets.length}`}
                totalPages={totalCatalogPages}
              />
            )}
          </Panel>
        </div>

        {hasCatalogResults ? (
          <Card className="catalog-preview-panel catalog-preview-desktop" size="none">
            {renderPreviewContent()}
          </Card>
        ) : (
          <Empty className="catalog-preview-panel catalog-preview-panel-empty" size="lg" variant="bordered">
            <EmptyIcon><LayoutGrid /></EmptyIcon>
            <EmptyHeader>
              <EmptyTitle>선택할 데이터셋이 없습니다.</EmptyTitle>
              <EmptyDescription>검색 조건을 바꾸면 일치하는 데이터셋의 스키마, 리니지, SQL 이동 정보를 다시 확인할 수 있습니다.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {activeModal && (
        <CatalogModal
          dataset={previewDataset}
          onClose={() => setActiveModal(null)}
          title={activeModal === "schema" ? "스키마 및 샘플 데이터" : "리니지"}
          variant={activeModal}
        >
          {activeModal === "schema" ? <CatalogDatasetViewer dataset={previewDataset} /> : <CatalogLineage dataset={previewDataset} compact />}
        </CatalogModal>
      )}
    </div>
    </TooltipProvider>
  );
}

export function CatalogModal({
  children,
  dataset,
  onClose,
  title,
  variant,
}: {
  children: React.ReactNode;
  dataset: CatalogDataset;
  onClose: () => void;
  title: string;
  variant: "lineage" | "schema";
}) {
  return (
    <DialogShell
      aria-label={`${dataset.name} ${title}`}
      bodyClassName="catalog-modal-body"
      bodyScrollArea={variant === "schema"}
      closeLabel="닫기"
      contentClassName={`catalog-modal ${variant === "lineage" ? "lineage-modal" : ""}`}
      headerActions={<IconButton label="닫기" size="xs" type="button" variant="ghost" onClick={onClose}><X /></IconButton>}
      headerClassName="catalog-modal-header"
      onClose={onClose}
      showCloseButton={false}
      size={variant === "lineage" ? "wide" : "xl"}
      title={dataset.name}
    >
      {children}
    </DialogShell>
  );
}
