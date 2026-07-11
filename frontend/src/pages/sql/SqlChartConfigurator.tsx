import { useEffect, useMemo, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { WidgetConfigPanel } from "../dashboard/runtime/WidgetConfigPanel";
import type {
  CreateDraftWidgetFormInput,
  DashboardDatasetOption,
} from "../dashboard/runtime/dashboardRuntimeTypes";
import type { SqlChartConfig, SqlChartSource } from "./SqlResultChart";

function toConfigDataset(source: SqlChartSource): DashboardDatasetOption {
  return {
    ...source.dataset,
    id: source.id,
    name: source.label,
  };
}

export function SqlChartConfigurator({
  initialConfig,
  onApply,
  sources,
}: {
  initialConfig?: SqlChartConfig | null;
  onApply: (config: SqlChartConfig) => void;
  sources: SqlChartSource[];
}) {
  const sourceKey = sources.map((source) => source.id).join("|");
  const datasets = useMemo(() => sources.map(toConfigDataset), [sources]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() => (
    sources.some((source) => source.id === initialConfig?.sourceId)
      ? initialConfig?.sourceId ?? null
      : sources[0]?.id ?? null
  ));

  useEffect(() => {
    setSelectedSourceId((current) => {
      if (initialConfig && sources.some((source) => source.id === initialConfig.sourceId)) {
        return initialConfig.sourceId;
      }
      if (current && sources.some((source) => source.id === current)) return current;
      return sources[0]?.id ?? null;
    });
  }, [initialConfig?.sourceId, sourceKey]);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedSourceId) ?? null,
    [datasets, selectedSourceId],
  );
  const initialCreateInput = useMemo<CreateDraftWidgetFormInput | null>(() => {
    if (!initialConfig || initialConfig.sourceId !== selectedSourceId) return null;
    return {
      config: initialConfig.config,
      datasetId: initialConfig.sourceId,
      title: initialConfig.title,
      type: initialConfig.type,
    };
  }, [initialConfig, selectedSourceId]);

  const applyWidget = (input: CreateDraftWidgetFormInput) => {
    onApply({
      config: input.config,
      sourceId: input.datasetId,
      title: input.title,
      type: input.type,
    });
  };

  return (
    <ScrollArea className="h-full min-h-0" type="always">
      <div className="min-w-0 p-3 pr-4">
        <WidgetConfigPanel
          createButtonLabel={initialCreateInput ? "변경 적용" : "차트 생성하기"}
          datasets={datasets}
          initialCreateInput={initialCreateInput}
          onCreateWidget={applyWidget}
          onSelectDataset={setSelectedSourceId}
          selectedDataset={selectedDataset}
          selectedDatasetId={selectedSourceId}
        />
      </div>
    </ScrollArea>
  );
}
