import { useEffect, useMemo, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { CalendarDays, Database, Hash, LetterText, Server, Table2 } from "lucide-react";
import Tooltip from "@mui/material/Tooltip";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";

type DatasetSidebarProps = {
  datasets: DashboardDatasetOption[];
  error?: Error | null;
  isOpen?: boolean;
  isLoading?: boolean;
  onSelectColumn?: (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => void;
  onSelectDataset: (datasetId: string) => void;
  selectedDatasetId: string | null;
};

const COLUMN_ITEM_PREFIX = "column:";
const DATASET_ITEM_PREFIX = "dataset:";
const systemItemId = "dataset-tree-system";
const schemaItemId = "dataset-tree-schema";
const tablesItemId = "dataset-tree-tables";
const hoverTooltipSlotProps = {
  arrow: { className: "asklake-dataset-hover-arrow" },
  tooltip: { className: "asklake-dataset-hover-tooltip" },
};

function datasetTreeItemId(datasetId: string) {
  return `${DATASET_ITEM_PREFIX}${datasetId}`;
}

function columnTreeItemId(datasetId: string, columnName: string) {
  return `${COLUMN_ITEM_PREFIX}${datasetId}:${columnName}`;
}

function parseColumnTreeItemId(itemId: string) {
  if (!itemId.startsWith(COLUMN_ITEM_PREFIX)) return null;
  const columnPath = itemId.slice(COLUMN_ITEM_PREFIX.length);
  const [datasetId, ...columnNameParts] = columnPath.split(":");
  const columnName = columnNameParts.join(":");
  if (!datasetId || !columnName) return null;
  return { columnName, datasetId };
}

function columnTypeLabel(type: DashboardDatasetColumn["type"]) {
  if (type === "number") return "number";
  if (type === "date") return "date";
  return "string";
}

function ColumnTypeIcon({ type }: { type: DashboardDatasetColumn["type"] }) {
  if (type === "number") return <Hash size={15} />;
  if (type === "date") return <CalendarDays size={15} />;
  return <LetterText size={15} />;
}

function columnDescription(column: DashboardDatasetColumn) {
  if (column.type === "number") return "집계, 지표, 차트 값으로 사용할 수 있는 숫자 필드입니다.";
  if (column.type === "date") return "기간 필터와 시계열 축에 사용할 수 있는 날짜 필드입니다.";
  return "분류, 이름, 상태처럼 그룹을 나누는 텍스트 필드입니다.";
}

function metricCount(dataset: DashboardDatasetOption) {
  return dataset.columns.filter((column) => column.type === "number").length;
}

function DatasetHoverCard({
  description,
  icon,
  rows,
  subtitle,
  title,
}: {
  description: string;
  icon: ReactNode;
  rows: Array<{ label: string; value: string }>;
  subtitle?: string;
  title: string;
}) {
  return (
    <div className="asklake-dataset-hover-card">
      <div className="asklake-dataset-hover-card-head">
        <span className="asklake-dataset-hover-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p>{description}</p>
    </div>
  );
}

function DatasetTreeLabel({
  hoverCard,
  icon,
  meta,
  selected = false,
  title,
}: {
  hoverCard?: ReactNode;
  icon: ReactNode;
  meta?: string;
  selected?: boolean;
  title: string;
}) {
  const label = (
    <span className={selected ? "asklake-dataset-tree-label selected" : "asklake-dataset-tree-label"}>
      <span className="asklake-dataset-tree-icon" aria-hidden="true">{icon}</span>
      <span className="asklake-dataset-tree-copy">
        <strong>{title}</strong>
        {meta && <em>{meta}</em>}
      </span>
    </span>
  );

  if (!hoverCard) return label;

  return (
    <Tooltip
      arrow
      describeChild
      enterDelay={250}
      enterNextDelay={120}
      leaveDelay={80}
      placement="right-start"
      slotProps={hoverTooltipSlotProps}
      title={hoverCard}
    >
      {label}
    </Tooltip>
  );
}

export function DatasetSidebar({
  datasets,
  error = null,
  isOpen = true,
  isLoading = false,
  onSelectColumn,
  onSelectDataset,
  selectedDatasetId,
}: DatasetSidebarProps) {
  const totalColumnCount = useMemo(
    () => datasets.reduce((total, dataset) => total + dataset.columns.length, 0),
    [datasets],
  );
  const totalMetricCount = useMemo(
    () => datasets.reduce((total, dataset) => total + metricCount(dataset), 0),
    [datasets],
  );
  const requiredExpandedItems = useMemo(
    () => [
      systemItemId,
      schemaItemId,
      tablesItemId,
      ...(selectedDatasetId ? [datasetTreeItemId(selectedDatasetId)] : []),
    ],
    [selectedDatasetId],
  );
  const [expandedItems, setExpandedItems] = useState(requiredExpandedItems);

  useEffect(() => {
    setExpandedItems((currentItems) => {
      const nextItems = new Set(currentItems);
      requiredExpandedItems.forEach((itemId) => nextItems.add(itemId));
      return Array.from(nextItems);
    });
  }, [requiredExpandedItems]);

  const handleActivateTreeItem = (itemId: string | null) => {
    if (typeof itemId !== "string") return;

    if (itemId.startsWith(DATASET_ITEM_PREFIX)) {
      setExpandedItems((currentItems) => (
        currentItems.includes(itemId) ? currentItems : [...currentItems, itemId]
      ));
      onSelectDataset(itemId.slice(DATASET_ITEM_PREFIX.length));
      return;
    }

    const columnItem = parseColumnTreeItemId(itemId);
    if (!columnItem) return;
    const dataset = datasets.find((item) => item.id === columnItem.datasetId);
    const column = dataset?.columns.find((item) => item.name === columnItem.columnName);
    if (!dataset || !column) return;
    const parentDatasetItemId = datasetTreeItemId(dataset.id);
    setExpandedItems((currentItems) => (
      currentItems.includes(parentDatasetItemId) ? currentItems : [...currentItems, parentDatasetItemId]
    ));
    onSelectColumn?.(dataset, column);
  };
  const handleTreeMouseDownCapture = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const treeItem = target?.closest('[role="treeitem"]');
    if (!treeItem || !event.currentTarget.contains(treeItem)) return;

    const domItemId = treeItem.getAttribute("id") ?? "";
    const columnItemIndex = domItemId.indexOf(COLUMN_ITEM_PREFIX);
    if (columnItemIndex >= 0) {
      handleActivateTreeItem(domItemId.slice(columnItemIndex));
      return;
    }

    const datasetItemIndex = domItemId.indexOf(DATASET_ITEM_PREFIX);
    if (datasetItemIndex >= 0) handleActivateTreeItem(domItemId.slice(datasetItemIndex));
  };

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label="데이터셋"
      className="asklake-dashboard-dataset-sidebar"
      id="asklake-dashboard-dataset-sidebar"
      onMouseDownCapture={handleTreeMouseDownCapture}
    >
      <div className="asklake-dataset-sidebar-header">
        <h2>데이터셋</h2>
      </div>

      {isLoading ? (
        <div className="asklake-dataset-sidebar-state">데이터셋을 불러오는 중입니다.</div>
      ) : error ? (
        <div className="asklake-dataset-sidebar-state error">
          데이터셋 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </div>
      ) : datasets.length === 0 ? (
        <div className="asklake-dataset-sidebar-state">표시할 데이터셋이 없습니다.</div>
      ) : (
        <div className="asklake-dataset-tree-wrap">
          <SimpleTreeView
            className="asklake-dataset-tree"
            expandedItems={expandedItems}
            selectedItems={selectedDatasetId ? datasetTreeItemId(selectedDatasetId) : null}
            onExpandedItemsChange={(_event: SyntheticEvent | null, itemIds: string[]) => {
              setExpandedItems((currentItems) => Array.from(new Set([...currentItems, ...itemIds])));
            }}
          >
            <TreeItem
              itemId={systemItemId}
              label={(
                <DatasetTreeLabel
                  hoverCard={(
                    <DatasetHoverCard
                      description="대시보드에서 사용할 수 있는 데이터셋 카탈로그입니다."
                      icon={<Server size={18} />}
                      rows={[
                        { label: "소유자", value: "System user" },
                        { label: "업데이트됨", value: "1시간 전" },
                        { label: "테이블", value: `${datasets.length}개` },
                      ]}
                      title="system"
                    />
                  )}
                  icon={<Server size={15} />}
                  title="system"
                />
              )}
            >
              <TreeItem
                itemId={schemaItemId}
                label={(
                  <DatasetTreeLabel
                    hoverCard={(
                      <DatasetHoverCard
                        description="대시보드 위젯 생성에 사용할 수 있는 데이터셋 묶음입니다."
                        icon={<Database size={18} />}
                        rows={[
                          { label: "소유자", value: "System user" },
                          { label: "테이블", value: `${datasets.length}개` },
                          { label: "컬럼", value: `${totalColumnCount}개` },
                        ]}
                        subtitle="system"
                        title="datasets"
                      />
                    )}
                    icon={<Database size={15} />}
                    title="datasets"
                  />
                )}
              >
                <TreeItem
                  itemId={tablesItemId}
                  label={(
                    <DatasetTreeLabel
                      hoverCard={(
                        <DatasetHoverCard
                          description="위젯의 원본으로 선택할 수 있는 테이블 목록입니다."
                          icon={<Table2 size={18} />}
                          rows={[
                            { label: "테이블", value: `${datasets.length}개` },
                            { label: "컬럼", value: `${totalColumnCount}개` },
                            { label: "지표", value: `${totalMetricCount}개` },
                          ]}
                          subtitle="system.datasets"
                          title={`테이블(${datasets.length})`}
                        />
                      )}
                      icon={<Table2 size={15} />}
                      title={`테이블(${datasets.length})`}
                    />
                  )}
                >
                  {datasets.map((dataset) => {
                    const isSelected = dataset.id === selectedDatasetId;
                    const numericColumnCount = metricCount(dataset);
                    return (
                      <TreeItem
                        itemId={datasetTreeItemId(dataset.id)}
                        key={dataset.id}
                        label={(
                          <DatasetTreeLabel
                            hoverCard={(
                              <DatasetHoverCard
                                description={dataset.description ?? "대시보드 위젯에 사용할 수 있는 데이터셋입니다."}
                                icon={<Table2 size={18} />}
                                rows={[
                                  { label: "소유자", value: "System user" },
                                  { label: "최근 수정 날짜", value: dataset.updatedAt ?? "정보 없음" },
                                  { label: "컬럼", value: `${dataset.columns.length}개` },
                                  { label: "지표", value: `${numericColumnCount} metrics` },
                                ]}
                                subtitle="system.datasets"
                                title={dataset.name}
                              />
                            )}
                            icon={<Table2 size={15} />}
                            meta={`${dataset.columns.length} columns`}
                            selected={isSelected}
                            title={dataset.name}
                          />
                        )}
                      >
                        {dataset.columns.map((column) => (
                          <TreeItem
                            itemId={columnTreeItemId(dataset.id, column.name)}
                            key={`${dataset.id}-${column.name}`}
                            label={(
                              <DatasetTreeLabel
                                hoverCard={(
                                  <DatasetHoverCard
                                    description={columnDescription(column)}
                                    icon={<ColumnTypeIcon type={column.type} />}
                                    rows={[
                                      { label: "유형", value: columnTypeLabel(column.type) },
                                      { label: "테이블", value: dataset.name },
                                    ]}
                                    subtitle={`system.datasets.${dataset.name}`}
                                    title={column.name}
                                  />
                                )}
                                icon={<ColumnTypeIcon type={column.type} />}
                                meta={columnTypeLabel(column.type)}
                                title={column.name}
                              />
                            )}
                          />
                        ))}
                      </TreeItem>
                    );
                  })}
                </TreeItem>
              </TreeItem>
            </TreeItem>
          </SimpleTreeView>
        </div>
      )}
    </aside>
  );
}
