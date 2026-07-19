import { useMemo, type ReactNode } from "react";
import { AlertCircle, CalendarDays, Database, Hash, LetterText, Server, Table2, X } from "lucide-react";
import type { NodeApi } from "react-arborist";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ExplorerTree, type ExplorerTreeNode } from "@/components/ui/explorer-tree";
import { IconButton } from "@/components/ui/icon-button";
import { PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TreeHoverCard } from "@/components/ui/tree-hover-card";
import { cn } from "@/lib/utils";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";

type DatasetSidebarProps = {
  datasets: DashboardDatasetOption[];
  error?: Error | null;
  isOpen?: boolean;
  isLoading?: boolean;
  onClose?: () => void;
  onSelectColumn?: (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => void;
  onSelectDataset: (datasetId: string) => void;
  selectedDatasetId: string | null;
  selectedDatasetIds?: string[];
};

type DatasetTreeNode = ExplorerTreeNode & {
  children?: DatasetTreeNode[];
  columnName?: string;
  datasetId?: string;
  hoverCard?: ReactNode;
  icon: ReactNode;
  id: string;
  kind: "column" | "dataset" | "group";
  meta?: string;
  selected?: boolean;
  title: string;
};

const COLUMN_ITEM_PREFIX = "column:";
const DATASET_ITEM_PREFIX = "dataset:";
const systemItemId = "dataset-tree-system";
const schemaItemId = "dataset-tree-schema";
const tablesItemId = "dataset-tree-tables";

function datasetTreeItemId(datasetId: string) {
  return `${DATASET_ITEM_PREFIX}${datasetId}`;
}

function columnTreeItemId(datasetId: string, columnName: string) {
  return `${COLUMN_ITEM_PREFIX}${datasetId}:${columnName}`;
}

function columnTypeLabel(type: DashboardDatasetColumn["type"]) {
  if (type === "number") return "number";
  if (type === "date") return "date";
  return "string";
}

function ColumnTypeIcon({ type }: { type: DashboardDatasetColumn["type"] }) {
  if (type === "number") return <Hash className="text-violet-600" />;
  if (type === "date") return <CalendarDays className="text-emerald-600" />;
  return <LetterText className="text-sky-600" />;
}

function columnDescription(column: DashboardDatasetColumn) {
  if (column.type === "number") return "Numeric field available for metrics and chart values.";
  if (column.type === "date") return "Date field available for period filters and time axes.";
  return "Text field available for labels, groups, and status values.";
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
    <TreeHoverCard
      className="asklake-dataset-hover-card"
      description={description}
      headerClassName="asklake-dataset-hover-card-head"
      icon={icon}
      iconClassName="asklake-dataset-hover-card-icon"
      rows={rows}
      subtitle={subtitle}
      title={title}
    />
  );
}

function DatasetTreeLabel({
  hoverCard,
  selected = false,
  title,
}: {
  hoverCard?: ReactNode;
  selected?: boolean;
  title: string;
}) {
  const label = (
    <span className={cn("block min-w-0 truncate font-semibold", selected && "text-blue-700")}>
      {title}
    </span>
  );

  if (!hoverCard) return label;

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent align="start" className="asklake-dataset-hover-tooltip" side="right" sideOffset={12}>
        {hoverCard}
      </TooltipContent>
    </Tooltip>
  );
}

function DatasetTreeSkeleton() {
  return (
    <div aria-label="Dataset tree loading" className="grid gap-3 p-3" role="status">
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="ml-5 h-9 w-3/4" />
      <Skeleton className="ml-10 h-9 w-4/5" />
      <Skeleton className="ml-14 h-12 w-3/4" />
    </div>
  );
}

export function DatasetSidebar({
  datasets,
  error = null,
  isOpen = true,
  isLoading = false,
  onClose,
  onSelectColumn,
  onSelectDataset,
  selectedDatasetId,
  selectedDatasetIds = [],
}: DatasetSidebarProps) {
  const totalColumnCount = useMemo(
    () => datasets.reduce((total, dataset) => total + dataset.columns.length, 0),
    [datasets],
  );
  const totalMetricCount = useMemo(
    () => datasets.reduce((total, dataset) => total + metricCount(dataset), 0),
    [datasets],
  );
  const treeData = useMemo<DatasetTreeNode[]>(() => [
    {
      children: [
        {
          children: [
            {
              children: datasets.map((dataset) => {
                const numericColumnCount = metricCount(dataset);
                return {
                  children: dataset.columns.map((column) => ({
                    columnName: column.name,
                    datasetId: dataset.id,
                    hoverCard: (
                      <DatasetHoverCard
                        description={columnDescription(column)}
                        icon={<ColumnTypeIcon type={column.type} />}
                        rows={[
                          { label: "type", value: columnTypeLabel(column.type) },
                          { label: "table", value: dataset.name },
                        ]}
                        subtitle={`system.datasets.${dataset.name}`}
                        title={column.name}
                      />
                    ),
                    icon: <ColumnTypeIcon type={column.type} />,
                    id: columnTreeItemId(dataset.id, column.name),
                    kind: "column" as const,
                    label: column.name,
                    meta: columnTypeLabel(column.type),
                    title: column.name,
                  })),
                  datasetId: dataset.id,
                  hoverCard: (
                    <DatasetHoverCard
                      description={dataset.description ?? "Dataset available for dashboard widgets."}
                      icon={<Table2 />}
                      rows={[
                        { label: "owner", value: "System user" },
                        { label: "updated", value: dataset.updatedAt ?? "unknown" },
                        { label: "columns", value: `${dataset.columns.length}` },
                        { label: "metrics", value: `${numericColumnCount}` },
                      ]}
                      subtitle="system.datasets"
                      title={dataset.name}
                    />
                  ),
                  icon: <Table2 className="text-blue-600" />,
                  id: datasetTreeItemId(dataset.id),
                  kind: "dataset" as const,
                  label: dataset.name,
                  selected: dataset.id === selectedDatasetId || selectedDatasetIds.includes(dataset.id),
                  title: dataset.name,
                };
              }),
              hoverCard: (
                <DatasetHoverCard
                  description="Tables available as widget sources."
                  icon={<Table2 />}
                  rows={[
                    { label: "tables", value: `${datasets.length}` },
                    { label: "columns", value: `${totalColumnCount}` },
                    { label: "metrics", value: `${totalMetricCount}` },
                  ]}
                  subtitle="system.datasets"
                  title="테이블"
                />
              ),
              icon: <Table2 className="text-indigo-600" />,
              id: tablesItemId,
              kind: "group",
              label: "테이블",
              meta: `${datasets.length}개`,
              title: "테이블",
            },
          ],
          hoverCard: (
            <DatasetHoverCard
              description="Dataset group available for dashboard widget creation."
              icon={<Database />}
              rows={[
                { label: "owner", value: "System user" },
                { label: "tables", value: `${datasets.length}` },
                { label: "columns", value: `${totalColumnCount}` },
              ]}
              subtitle="system"
              title="datasets"
            />
          ),
          icon: <Database className="text-cyan-600" />,
          id: schemaItemId,
          kind: "group",
          label: "datasets",
          title: "datasets",
        },
      ],
      hoverCard: (
        <DatasetHoverCard
          description="Dataset catalog available for dashboard widgets."
          icon={<Server />}
          rows={[
            { label: "owner", value: "System user" },
            { label: "updated", value: "1 hour ago" },
            { label: "tables", value: `${datasets.length}` },
          ]}
          title="system"
        />
      ),
      icon: <Server className="text-blue-700" />,
      id: systemItemId,
      kind: "group",
      label: "system",
      title: "system",
    },
  ], [datasets, selectedDatasetId, selectedDatasetIds, totalColumnCount, totalMetricCount]);

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label="데이터"
      className="asklake-dashboard-dataset-sidebar"
      id="asklake-dashboard-dataset-sidebar"
    >
      <PanelHeader
        actions={onClose ? (
          <IconButton label="데이터 패널 닫기" size="xs" variant="ghost" onClick={onClose}>
            <X />
          </IconButton>
        ) : undefined}
        className="min-h-0 p-4"
        description="위젯에 연결할 데이터셋과 필드를 선택하세요."
        icon={<Database />}
        iconVariant="outline"
        title="데이터"
      />

      {isLoading ? (
        <DatasetTreeSkeleton />
      ) : error ? (
        <Alert className="m-3 w-auto" variant="destructive">
          <AlertCircle />
          <AlertTitle>Dataset을 불러오지 못했습니다.</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : datasets.length === 0 ? (
        <Empty className="m-3" size="sm" variant="bordered">
          <EmptyHeader>
            <EmptyTitle>사용 가능한 Dataset이 없습니다.</EmptyTitle>
            <EmptyDescription>Catalog에서 Dataset을 준비한 뒤 다시 시도해 주세요.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <TooltipProvider delayDuration={250}>
          <ExplorerTree<DatasetTreeNode>
            ariaLabel="Dashboard dataset tree"
            className="mt-2 min-h-0 flex-1 pr-2"
            data={treeData}
            defaultHeight={620}
            disableSelect
            getIcon={(node) => node.data.icon}
            getLabel={(node) => (
              <DatasetTreeLabel
                hoverCard={node.data.hoverCard}
                selected={node.data.selected}
                title={node.data.title}
              />
            )}
            getRowProps={(node) => ({
              "data-dashboard-dataset-node": node.data.kind,
              title: node.data.title,
            })}
            initialOpenState={{
              [systemItemId]: true,
              [schemaItemId]: true,
              [tablesItemId]: true,
            }}
            indent={12}
            minHeight={320}
            rowHeight={40}
            toggleOnRowPress={false}
            onNodePress={(node: NodeApi<DatasetTreeNode>) => {
              const item = node.data;
              if (item.kind === "dataset" && item.datasetId) {
                onSelectDataset(item.datasetId);
                return;
              }
              if (item.kind !== "column" || !item.datasetId || !item.columnName) return;
              const dataset = datasets.find((entry) => entry.id === item.datasetId);
              const column = dataset?.columns.find((entry) => entry.name === item.columnName);
              if (dataset && column) onSelectColumn?.(dataset, column);
            }}
          />
        </TooltipProvider>
      )}
    </aside>
  );
}
