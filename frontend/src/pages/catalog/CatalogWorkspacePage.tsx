import type { AuditResult, CatalogDataset } from "../../types";
import { Button } from "../../components/ui/button";
import { SemanticLayerPage } from "../semantic/SemanticLayerPage";
import { CatalogPage as CatalogExplorerPage } from "./CatalogExplorerPage";

export type CatalogView = "catalog" | "semantic";

export function CatalogPage({
  view = "catalog",
  onViewChange,
  ...catalogProps
}: {
  datasets: CatalogDataset[];
  error?: string | null;
  loading?: boolean;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onOpenSql: (dataset: CatalogDataset) => void;
  onRefresh?: () => void;
  onViewChange?: (view: CatalogView) => void;
  selectedDataset: CatalogDataset;
  view?: CatalogView;
}) {
  const viewSwitcher = onViewChange ? (
    <div aria-label="검색/카탈로그 보기" className="catalog-view-switcher" role="tablist">
      <Button aria-selected={view === "catalog"} className="catalog-view-button" onClick={() => onViewChange("catalog")} role="tab" size="sm" type="button" variant={view === "catalog" ? "primary" : "outline"}>
        데이터 카탈로그
      </Button>
      <Button aria-selected={view === "semantic"} className="catalog-view-button" onClick={() => onViewChange("semantic")} role="tab" size="sm" type="button" variant={view === "semantic" ? "primary" : "outline"}>
        분석 기준
      </Button>
    </div>
  ) : null;

  if (view === "semantic") {
    return (
      <div className="catalog-semantic-page">
        {viewSwitcher}
        <SemanticLayerPage datasets={catalogProps.datasets} onAction={catalogProps.onAction} />
      </div>
    );
  }

  return (
    <div className="catalog-explorer-with-view">
      {viewSwitcher}
      <CatalogExplorerPage {...catalogProps} />
    </div>
  );
}
