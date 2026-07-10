import { Fragment } from "react";
import { Plus, Table2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldTitle } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { CatalogDataset } from "../../types";

export function SchemaDetailsPanel({
  dataset,
  selectedDatasets,
  onColumnClick,
  onJoinDataset,
  onSelectedDatasetRemove,
  onSchemaSelect,
}: {
  dataset: CatalogDataset | null;
  selectedDatasets: CatalogDataset[];
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
  onJoinDataset: (dataset: CatalogDataset) => void;
  onSelectedDatasetRemove: (dataset: CatalogDataset) => void;
  onSchemaSelect: (dataset: CatalogDataset) => void;
}) {
  if (!dataset) {
    return (
      <Panel asChild>
        <aside className="sql-schema-panel empty">
          <ScrollArea className="h-full" type="always">
            <div className="grid min-h-full min-w-0 grid-rows-[max-content_minmax(0,1fr)] gap-4 pr-3">
              <PanelHeader
                bordered={false}
                className="min-h-0 p-0"
                icon={<Table2 size={16} />}
                title="선택된 테이블 없음"
              />
              <Empty className="sql-schema-panel-empty" size="sm" variant="bordered">
                <EmptyHeader>
                  <EmptyTitle>선택 없음</EmptyTitle>
                  <EmptyDescription>소스, 담당자, 컬럼 정보</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          </ScrollArea>
        </aside>
      </Panel>
    );
  }

  return (
    <Panel asChild>
      <aside className="sql-schema-panel">
        <ScrollArea className="h-full" type="always">
          <div className="grid min-w-0 gap-4 pr-3">
            <section className="grid min-w-0 gap-2" aria-label="선택 테이블">
              <PanelHeader
                bordered={false}
                className="min-h-0 p-0"
                icon={<Table2 size={16} />}
                title="선택 테이블"
              />
              <Panel className="grid min-w-0 gap-0">
                {selectedDatasets.map((item, index) => {
                  const active = item.id === dataset.id;
                  const isBaseDataset = index === 0;
                  return (
                    <Fragment key={item.id}>
                      {index > 0 && <Separator />}
                      <div
                        className={cn(
                          "grid min-h-14 grid-cols-[minmax(0,1fr)_64px_40px] items-center rounded-lg transition-colors hover:bg-blue-50",
                          active && "bg-blue-50",
                        )}
                        data-sql-selected-dataset-row=""
                      >
                        <Button
                          aria-pressed={active}
                          className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] gap-2 bg-transparent px-2.5 text-left hover:bg-transparent"
                          type="button"
                          variant="ghost"
                          onClick={() => onSchemaSelect(item)}
                        >
                          <Badge size="sm" variant={active ? "default" : "secondary"}>{index + 1}</Badge>
                          <FieldTitle className="truncate" title={item.name}>{item.name}</FieldTitle>
                          <Badge size="sm" variant="secondary">{item.schema.length}컬럼</Badge>
                        </Button>
                        <Button
                          aria-label={`${item.name} JOIN SQL 생성`}
                          disabled={isBaseDataset}
                          onClick={() => onJoinDataset(item)}
                          title={isBaseDataset ? "기준 테이블입니다" : "이 테이블을 SQL에 JOIN"}
                          type="button"
                          size="sm"
                          variant="ghost"
                        >
                          JOIN
                        </Button>
                        <Button
                          aria-label={`${item.name} 선택 해제`}
                          className="size-8"
                          onClick={() => onSelectedDatasetRemove(item)}
                          title="선택 해제"
                          type="button"
                          size="icon"
                          variant="ghost"
                        >
                          <X data-icon="inline-start" />
                        </Button>
                      </div>
                    </Fragment>
                  );
                })}
              </Panel>
            </section>
            <Separator />
            <PanelHeader
              bordered={false}
              className="min-h-0 p-0"
              icon={<Table2 size={16} />}
              meta={(
                <>
                  <Badge size="sm" variant="secondary">{dataset.layer}</Badge>
                  <Badge size="sm" variant="secondary">{dataset.schema.length} 컬럼</Badge>
                  {dataset.rag && <Badge size="sm" variant="default">RAG</Badge>}
                </>
              )}
              title={dataset.name}
            />
            <SelectedSchemaColumnList dataset={dataset} onColumnClick={onColumnClick} />
          </div>
        </ScrollArea>
      </aside>
    </Panel>
  );
}

function SelectedSchemaColumnList({
  dataset,
  onColumnClick,
}: {
  dataset: CatalogDataset;
  onColumnClick: (dataset: CatalogDataset, columnName: string) => void;
}) {
  return (
    <Panel className="grid min-h-[180px] content-start gap-0 p-2" variant="muted">
      {dataset.schema.map(([name, type], index) => (
        <Fragment key={`${dataset.id}-${name}-${index}`}>
          {index > 0 && <Separator />}
          <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(120px,max-content)] items-center gap-2.5 px-2">
            <FieldTitle className="truncate" title={name}>{name}</FieldTitle>
            <div className="inline-flex min-w-0 items-center justify-self-end gap-1.5">
              <Badge className="max-w-[min(128px,44vw)] min-w-[70px] truncate" size="sm" title={type} variant="secondary">
                {type}
              </Badge>
              <Button
                aria-label={`${dataset.name}.${name} 컬럼 SQL에 삽입`}
                className="size-8"
                title="SQL에 삽입"
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onColumnClick(dataset, name)}
              >
                <Plus data-icon="inline-start" />
              </Button>
            </div>
          </div>
        </Fragment>
      ))}
    </Panel>
  );
}
