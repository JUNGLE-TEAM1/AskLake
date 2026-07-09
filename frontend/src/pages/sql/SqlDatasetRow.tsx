import { Calendar, ChevronDown, ChevronRight, Database, Hash, Plus, Server, Table2, Type } from "lucide-react";
import { useState } from "react";
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
    <div className="sql-dataset-tree" role="tree" aria-label="분석 데이터셋 트리">
      <div className="sql-tree-node depth-0" role="treeitem" aria-expanded="true">
        <ChevronDown size={15} />
        <Server size={16} />
        <strong>system</strong>
      </div>
      <div className="sql-tree-branch depth-1">
        <div className="sql-tree-node" role="treeitem" aria-expanded="true">
          <ChevronDown size={15} />
          <Database size={16} />
          <strong>datasets</strong>
        </div>
        <div className="sql-tree-branch depth-2">
          <div className="sql-tree-node" role="treeitem" aria-expanded="true">
            <ChevronDown size={15} />
            <Table2 size={16} />
            <strong>테이블({datasets.length})</strong>
          </div>
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
        </div>
      </div>
    </div>
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
        <button
          aria-expanded={expanded}
          className="sql-tree-table-row"
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
        </button>
        <button className="sql-tree-add-button" type="button" aria-label={`${dataset.name} 선택 테이블에 추가`} onClick={() => onSelect(dataset)}>
          <Plus size={14} /> 추가
        </button>
      </div>
      {expanded && (
        <div className="sql-tree-column-list" role="group">
          {dataset.schema.map(([name, type], index) => {
            const Icon = getColumnIcon(type);
            return (
              <button
                className="sql-tree-column-row"
                key={`${dataset.id}-${name}-${index}`}
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
              </button>
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

  return (
    <aside className="sql-tree-hover-card" style={{ left: info.position.left, top: info.position.top }}>
      <div className={`sql-tree-hover-icon ${iconClassName}`}>
        {info.kind === "table" ? <Table2 size={22} /> : renderColumnIcon(info.columnType)}
      </div>
      <div className="sql-tree-hover-body">
        <strong>{info.kind === "table" ? info.dataset.name : info.columnName}</strong>
        <span>system.datasets.{info.dataset.name}</span>
        <dl>
          {info.kind === "table" ? (
            <>
              <dt>레이어</dt>
              <dd>{info.dataset.layer}</dd>
              <dt>컬럼</dt>
              <dd>{info.dataset.schema.length}개</dd>
              <dt>담당자</dt>
              <dd>{info.dataset.owner}</dd>
              <dt>만든 사람</dt>
              <dd>{info.dataset.createdByProfile?.displayName || info.dataset.createdBy || info.dataset.owner}</dd>
            </>
          ) : (
            <>
              <dt>유형</dt>
              <dd>{formatColumnType(info.columnType)}</dd>
              <dt>테이블</dt>
              <dd>{info.dataset.name}</dd>
            </>
          )}
        </dl>
        <p>{info.kind === "table" ? info.dataset.description : getColumnDescription(info.columnType)}</p>
      </div>
    </aside>
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
