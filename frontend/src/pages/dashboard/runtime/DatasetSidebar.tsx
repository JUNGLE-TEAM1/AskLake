import { Check, Database } from "lucide-react";
import type { DashboardDatasetOption } from "./dashboardRuntimeTypes";

type DatasetSidebarProps = {
  datasets: DashboardDatasetOption[];
  error?: Error | null;
  isOpen?: boolean;
  isLoading?: boolean;
  onSelectDataset: (datasetId: string) => void;
  selectedDatasetId: string | null;
};

export function DatasetSidebar({
  datasets,
  error = null,
  isOpen = true,
  isLoading = false,
  onSelectDataset,
  selectedDatasetId,
}: DatasetSidebarProps) {
  return (
    <aside
      aria-hidden={!isOpen}
      aria-label="Gold 데이터셋"
      className="asklake-dashboard-dataset-sidebar"
      id="asklake-dashboard-dataset-sidebar"
    >
      <div className="asklake-dataset-sidebar-header">
        <div>
          <span>Gold layer</span>
          <h2>데이터셋</h2>
        </div>
        <span className="asklake-dataset-layer-badge">Gold</span>
      </div>

      {isLoading ? (
        <div className="asklake-dataset-sidebar-state">데이터셋을 불러오는 중입니다.</div>
      ) : error ? (
        <div className="asklake-dataset-sidebar-state error">
          데이터셋 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </div>
      ) : datasets.length === 0 ? (
        <div className="asklake-dataset-sidebar-state">표시할 Gold 데이터셋이 없습니다.</div>
      ) : (
        <div className="asklake-dataset-list">
          {datasets.map((dataset) => {
            const isSelected = dataset.id === selectedDatasetId;
            const metricCount = dataset.columns.filter((column) => column.type === "number").length;
            return (
              <button
                aria-pressed={isSelected}
                className={isSelected ? "asklake-dataset-option active" : "asklake-dataset-option"}
                disabled={!isOpen}
                key={dataset.id}
                type="button"
                onClick={() => onSelectDataset(dataset.id)}
              >
                <span className="asklake-dataset-option-icon" aria-hidden="true">
                  {isSelected ? <Check size={15} /> : <Database size={15} />}
                </span>
                <span className="asklake-dataset-option-copy">
                  <strong>{dataset.name}</strong>
                  {dataset.description && <span>{dataset.description}</span>}
                  <em>{dataset.columns.length} columns · {metricCount} metrics</em>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
