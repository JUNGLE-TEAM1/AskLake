import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Panel } from "@/components/ui/panel";
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
          <header className="sql-schema-panel-header">
            <span>스키마</span>
            <h2>선택된 테이블 없음</h2>
          </header>
          <Empty className="sql-schema-panel-empty" size="sm" variant="bordered">
            <EmptyHeader>
              <EmptyTitle>선택 없음</EmptyTitle>
              <EmptyDescription>소스, 담당자, 컬럼 정보</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </aside>
      </Panel>
    );
  }

  return (
    <Panel asChild>
      <aside className="sql-schema-panel">
        <section className="sql-selected-datasets-panel" aria-label="선택 테이블">
        <div className="sql-selected-datasets-header">
          <span>선택 테이블</span>
          <Badge size="sm" variant="default">{selectedDatasets.length}개 선택됨</Badge>
        </div>
        <div className="sql-selected-dataset-list">
          {selectedDatasets.map((item, index) => {
            const active = item.id === dataset.id;
            const isBaseDataset = index === 0;
            return (
              <div className={cn("sql-selected-dataset-item", active && "active")} key={item.id}>
                <Button
                  aria-pressed={active}
                  className="sql-selected-dataset-main"
                  type="button"
                  variant="ghost"
                  onClick={() => onSchemaSelect(item)}
                >
                  <Badge size="sm" variant={active ? "default" : "secondary"}>{index + 1}</Badge>
                  <strong title={item.name}>{item.name}</strong>
                  <Badge size="sm" variant="secondary">{item.schema.length}컬럼</Badge>
                </Button>
                <Button
                  aria-label={`${item.name} JOIN SQL 생성`}
                  disabled={isBaseDataset}
                  onClick={() => onJoinDataset(item)}
                  title={isBaseDataset ? "기준 테이블입니다" : "이 테이블을 SQL에 JOIN"}
                  type="button"
                  size="sm"
                  variant="subtle"
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
            );
          })}
        </div>
        </section>
        <header className="sql-schema-panel-header">
        <span>선택한 테이블 스키마</span>
        <h2 title={dataset.name}>{dataset.name}</h2>
        <div className="sql-schema-panel-pills">
          <Badge size="sm" variant="secondary">{dataset.layer}</Badge>
          <Badge size="sm" variant="secondary">{dataset.schema.length} 컬럼</Badge>
          {dataset.rag && <Badge size="sm" variant="default">RAG</Badge>}
        </div>
        </header>
        <SelectedSchemaColumnList dataset={dataset} onColumnClick={onColumnClick} />
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
    <div className="sql-card-schema">
      {dataset.schema.map(([name, type], index) => (
        <div
          className="sql-card-schema-row"
          key={`${dataset.id}-${name}-${index}`}
        >
          <span className="sql-card-schema-name" title={name}>
            <strong>{name}</strong>
          </span>
          <span className="sql-card-schema-type-group">
            <Badge className="max-w-[min(128px,44vw)] min-w-[70px] overflow-hidden text-ellipsis" size="sm" title={type} variant="secondary">
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
          </span>
        </div>
      ))}
    </div>
  );
}
