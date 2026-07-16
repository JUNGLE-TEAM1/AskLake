import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  Check,
  Database,
  Info,
  RefreshCw
} from "lucide-react";
import type { CatalogDataset } from "../../types";


export function DataLakeDatasetList({
  datasets,
  error,
  loading,
  onSelect,
  selectedDatasetId,
}: {
  datasets: CatalogDataset[];
  error: string;
  loading: boolean;
  onSelect: (dataset: CatalogDataset) => void;
  selectedDatasetId: string;
}) {
  if (loading) {
    return <EmptyState description="현재 계정으로 볼 수 있는 데이터셋을 확인하고 있습니다." icon={<RefreshCw className="animate-spin" />} size="sm" title="데이터셋 불러오는 중" variant="plain" />;
  }
  if (error) {
    return <EmptyState description={error} icon={<Info />} size="sm" title="데이터셋을 불러오지 못했습니다." variant="plain" />;
  }
  if (datasets.length === 0) {
    return <EmptyState description="Catalog에서 조회 권한이 있는 사용 가능한 데이터셋이 없습니다." icon={<Database />} size="sm" title="표시할 데이터셋이 없습니다." variant="plain" />;
  }
  return (
    <div className="data-lake-dataset-list" role="listbox" aria-label="접근 가능한 AskLake 데이터셋">
      {datasets.map((dataset) => {
        const selected = dataset.id === selectedDatasetId;
        return (
          <button
            aria-selected={selected}
            className={cn("data-lake-dataset-row", selected && "is-selected")}
            key={dataset.id}
            role="option"
            type="button"
            onClick={() => onSelect(dataset)}
          >
            <span className="data-lake-dataset-icon"><Database /></span>
            <span className="data-lake-dataset-copy">
              <strong>{dataset.name}</strong>
              <span>{dataset.description || `${dataset.owner} 소유 데이터셋`}</span>
            </span>
            <span className="data-lake-dataset-meta">
              <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{dataset.layer}</Badge>
              <span>{dataset.schema.length}필드 · {dataset.rows}</span>
            </span>
            {selected ? <Check className="data-lake-dataset-check" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
