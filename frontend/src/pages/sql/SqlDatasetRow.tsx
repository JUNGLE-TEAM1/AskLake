import { Calendar, ChevronDown, ChevronRight, Database, Hash, Plus, Server, Table2, Type } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import { TreePanel } from "@/components/ui/tree-panel";
import { TreeGroup, TreeRow, TreeStaticRow, TreeView } from "@/components/ui/tree-view";
import type { CatalogDataset } from "../../types";

type SqlDatasetTreeProps = {
  datasets: CatalogDataset[];
  expandedDatasetId: string | null;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
};

type HoverInfo =
  | { dataset: CatalogDataset; kind: "table"; position: { left: number; top: number } }
  | { columnName: string; columnType: string; dataset: CatalogDataset; kind: "column"; position: { left: number; top: number } };

export function SqlDatasetTree({
  datasets,
  expandedDatasetId,
  onSelect,
  onToggle,
}: SqlDatasetTreeProps) {
  if (datasets.length === 0) return null;

  return (
    <TreePanel className="sql-dataset-tree">
      <TreeView className="sql-tree" label="분석 데이터셋 트리">
        <TreeStaticRow className="sql-tree-node depth-0" expanded level={0}>
          <ChevronDown size={15} />
          <Server size={16} />
          <strong>system</strong>
        </TreeStaticRow>
        <TreeGroup className="sql-tree-branch depth-1" level={1}>
          <TreeStaticRow className="sql-tree-node" expanded level={1}>
            <ChevronDown size={15} />
            <Database size={16} />
            <strong>datasets</strong>
          </TreeStaticRow>
          <TreeGroup className="sql-tree-branch depth-2" level={2}>
            <TreeStaticRow className="sql-tree-node" expanded level={2}>
              <ChevronDown size={15} />
              <Table2 size={16} />
              <strong>테이블({datasets.length})</strong>
            </TreeStaticRow>
            <div className="sql-tree-table-list">
              {datasets.map((dataset) => (
                <SqlDatasetTreeRow
                  dataset={dataset}
                  expanded={expandedDatasetId === dataset.id}
                  key={dataset.id}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </TreeGroup>
        </TreeGroup>
      </TreeView>
    </TreePanel>
  );
}

function SqlDatasetTreeRow({
  dataset,
  expanded,
  onSelect,
  onToggle,
}: {
  dataset: CatalogDataset;
  expanded: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  onToggle: (dataset: CatalogDataset) => void;
}) {
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const showTableInfo = (target: HTMLElement) => setHoverInfo({
    dataset,
    kind: "table",
    position: getHoverPosition(target),
  });
  const showColumnInfo = (target: HTMLElement, columnName: string, columnType: string) => setHoverInfo({
    columnName,
    columnType,
    dataset,
    kind: "column",
    position: getHoverPosition(target),
  });

  return (
    <article className={expanded ? "sql-tree-table-node active expanded" : "sql-tree-table-node"}>
      <div className="sql-tree-table-row-shell">
        <TreeRow
          aria-expanded={expanded}
          className="sql-tree-table-row"
          expanded={expanded}
          level={3}
          type="button"
          onClick={() => onToggle(dataset)}
          onBlur={() => setHoverInfo(null)}
          onFocus={(event) => showTableInfo(event.currentTarget)}
          onMouseEnter={(event) => showTableInfo(event.currentTarget)}
          onMouseLeave={() => setHoverInfo(null)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <Table2 size={16} />
          <span className="sql-tree-table-name">
            <strong title={dataset.name}>{dataset.name}</strong>
            <em>{dataset.schema.length} columns</em>
          </span>
        </TreeRow>
        <Button className="mr-2 min-w-[58px]" type="button" aria-label={`${dataset.name} 선택 테이블에 추가`} onClick={() => onSelect(dataset)} size="sm" variant="subtle">
          <Plus data-icon="inline-start" /> 추가
        </Button>
      </div>
      {expanded && (
        <div className="sql-tree-column-list" role="group">
          {dataset.schema.map(([name, type], index) => {
            const Icon = getColumnIcon(type);
            return (
              <TreeRow
                className="sql-tree-column-row"
                key={`${dataset.id}-${name}-${index}`}
                leaf
                level={4}
                type="button"
                onBlur={() => setHoverInfo(null)}
                onFocus={(event) => showColumnInfo(event.currentTarget, name, type)}
                onMouseEnter={(event) => showColumnInfo(event.currentTarget, name, type)}
                onMouseLeave={() => setHoverInfo(null)}
              >
                <Icon size={16} />
                <span>
                  <strong title={name}>{name}</strong>
                  <em>{formatColumnType(type)}</em>
                </span>
              </TreeRow>
            );
          })}
        </div>
      )}
      {hoverInfo && <SqlDatasetHoverCard info={hoverInfo} />}
    </article>
  );
}

function SqlDatasetHoverCard({ info }: { info: HoverInfo }) {
  const iconClassName = info.kind === "column" ? getColumnKind(info.columnType) : "table";
  const rows = info.kind === "table"
    ? [
      { label: "레이어", value: info.dataset.layer },
      { label: "컬럼", value: `${info.dataset.schema.length}개` },
      { label: "담당자", value: info.dataset.owner },
    ]
    : [
      { label: "유형", value: formatColumnType(info.columnType) },
      { label: "테이블", value: info.dataset.name },
    ];

  return (
    <TreeHoverCard
      as="aside"
      bodyClassName="sql-tree-hover-body"
      className="sql-tree-hover-card"
      description={info.kind === "table" ? info.dataset.description : getColumnDescription(info.columnType)}
      icon={info.kind === "table" ? <Table2 size={22} /> : renderColumnIcon(info.columnType)}
      iconClassName={`sql-tree-hover-icon ${iconClassName}`}
      rowLayout="flat"
      rows={rows}
      style={{ left: info.position.left, top: info.position.top }}
      subtitle={`system.datasets.${info.dataset.name}`}
      title={info.kind === "table" ? info.dataset.name : info.columnName}
    />
  );
}

function getHoverPosition(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const cardWidth = 360;
  const cardHeight = 210;
  const left = Math.min(rect.right + 16, window.innerWidth - cardWidth - 16);
  const top = Math.min(Math.max(16, rect.top - 8), window.innerHeight - cardHeight - 16);

  return { left, top };
}

function getColumnIcon(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return Hash;
  if (kind === "date") return Calendar;
  return Type;
}

function renderColumnIcon(type: string) {
  const Icon = getColumnIcon(type);
  return <Icon size={22} />;
}

function getColumnKind(type: string) {
  const normalized = type.toLowerCase();
  if (normalized.includes("int") || normalized.includes("decimal") || normalized.includes("number") || normalized.includes("float") || normalized.includes("double")) return "number";
  if (normalized.includes("date") || normalized.includes("time")) return "date";
  return "text";
}

function formatColumnType(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return "number";
  if (kind === "date") return "date";
  return "string";
}

function getColumnDescription(type: string) {
  const kind = getColumnKind(type);
  if (kind === "number") return "집계, 지표, 차트 값으로 사용할 수 있는 숫자 필드입니다.";
  if (kind === "date") return "기간 필터와 시계열 분석 기준으로 사용할 수 있는 날짜/시간 필드입니다.";
  return "그룹화, 필터, 라벨 기준으로 사용할 수 있는 문자열 필드입니다.";
}
