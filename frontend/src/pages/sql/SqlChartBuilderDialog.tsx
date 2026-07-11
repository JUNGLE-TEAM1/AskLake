import { useEffect, useMemo, useState } from "react";
import { ChartArea, ChartColumn, ChartLine, CircleDot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DashboardFieldCombobox } from "../dashboard/runtime/DashboardFieldCombobox";
import {
  createDefaultSqlChartConfig,
  getSqlChartConfigError,
  SqlResultChart,
  sqlChartAggregations,
  type SqlChartConfig,
  type SqlChartSource,
  type SqlChartType,
} from "./SqlResultChart";

const chartTypeOptions = [
  { icon: ChartColumn, label: "막대", value: "bar_chart" },
  { icon: ChartLine, label: "선", value: "line_chart" },
  { icon: ChartArea, label: "영역", value: "area_chart" },
  { icon: CircleDot, label: "도넛", value: "donut_chart" },
] satisfies Array<{ icon: typeof ChartColumn; label: string; value: SqlChartType }>;

const aggregationLabels = {
  avg: "평균",
  count: "개수",
  max: "최댓값",
  min: "최솟값",
  sum: "합계",
} as const;

function initialDraft(sources: SqlChartSource[], initialConfig?: SqlChartConfig | null) {
  const configuredSource = sources.find((source) => source.id === initialConfig?.sourceId);
  const initialSource = configuredSource ?? sources[0];
  if (!initialSource) return null;
  if (!initialConfig || !configuredSource) return createDefaultSqlChartConfig(initialSource, initialConfig?.type);

  const columnNames = new Set(initialSource.dataset.columns.map((column) => column.name));
  const defaultConfig = createDefaultSqlChartConfig(initialSource, initialConfig.type);
  return {
    ...initialConfig,
    categoryKey: columnNames.has(initialConfig.categoryKey) ? initialConfig.categoryKey : defaultConfig.categoryKey,
    sourceId: initialSource.id,
    valueKey: columnNames.has(initialConfig.valueKey) ? initialConfig.valueKey : defaultConfig.valueKey,
  };
}

export function SqlChartBuilderDialog({
  initialConfig,
  onApply,
  onOpenChange,
  open,
  sources,
}: {
  initialConfig?: SqlChartConfig | null;
  onApply: (config: SqlChartConfig) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sources: SqlChartSource[];
}) {
  const sourceKey = sources.map((source) => source.id).join("|");
  const initialConfigKey = initialConfig
    ? `${initialConfig.sourceId}|${initialConfig.type}|${initialConfig.categoryKey}|${initialConfig.valueKey}|${initialConfig.aggregation}`
    : "";
  const [draft, setDraft] = useState<SqlChartConfig | null>(() => initialDraft(sources, initialConfig));

  useEffect(() => {
    if (open) setDraft(initialDraft(sources, initialConfig));
  }, [initialConfigKey, open, sourceKey]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === draft?.sourceId),
    [draft?.sourceId, sources],
  );
  const columnOptions = useMemo(
    () => selectedSource?.dataset.columns.map((column) => ({ label: column.name, value: column.name })) ?? [],
    [selectedSource],
  );
  const numericColumnOptions = useMemo(
    () => selectedSource?.dataset.columns
      .filter((column) => column.type === "number")
      .map((column) => ({ label: column.name, value: column.name })) ?? [],
    [selectedSource],
  );
  const validationMessage = draft ? getSqlChartConfigError(draft, selectedSource) : "차트 데이터가 없습니다.";

  const selectSource = (sourceId: string) => {
    const source = sources.find((item) => item.id === sourceId);
    if (!source) return;
    setDraft((current) => createDefaultSqlChartConfig(source, current?.type));
  };

  const selectAggregation = (aggregation: SqlChartConfig["aggregation"]) => {
    setDraft((current) => {
      if (!current) return current;
      const valueKey = aggregation === "count"
        ? current.valueKey
        : current.valueKey || numericColumnOptions[0]?.value || "";
      return { ...current, aggregation, valueKey };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(780px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] max-w-none grid-rows-[max-content_minmax(0,1fr)_max-content] overflow-hidden">
        <DialogHeader>
          <DialogTitle>차트 만들기</DialogTitle>
          <DialogDescription>
            SQL 결과나 선택한 데이터셋에서 축과 집계 방식을 지정하고 결과를 미리 확인합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[minmax(280px,340px)_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
          <Card className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)] overflow-hidden" size="none">
            <CardHeader className="p-4">
              <CardTitle className="text-base">위젯 설정</CardTitle>
              <CardDescription>데이터와 차트 구성을 선택하세요.</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 p-0">
              <ScrollArea className="h-full" type="always">
                <FieldGroup className="p-4 pt-0">
                  <Field>
                    <FieldLabel>데이터 소스</FieldLabel>
                    <Select value={draft?.sourceId ?? ""} onValueChange={selectSource}>
                      <SelectTrigger size="sm">
                        <SelectValue placeholder="데이터 소스 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {sources.map((source) => (
                            <SelectItem key={source.id} value={source.id}>{source.label}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field>
                    <FieldLabel>차트 유형</FieldLabel>
                    <ToggleGroup
                      aria-label="차트 유형"
                      className="grid w-full grid-cols-2"
                      type="single"
                      value={draft?.type ?? "bar_chart"}
                      onValueChange={(value) => {
                        if (!value) return;
                        setDraft((current) => current ? { ...current, type: value as SqlChartType } : current);
                      }}
                    >
                      {chartTypeOptions.map((option) => {
                        const Icon = option.icon;
                        return (
                          <ToggleGroupItem key={option.value} value={option.value}>
                            <Icon aria-hidden="true" /> {option.label}
                          </ToggleGroupItem>
                        );
                      })}
                    </ToggleGroup>
                  </Field>

                  <DashboardFieldCombobox
                    label={draft?.type === "donut_chart" ? "분류" : "X축"}
                    onValueChange={(categoryKey) => setDraft((current) => current ? { ...current, categoryKey } : current)}
                    options={columnOptions}
                    value={draft?.categoryKey ?? ""}
                  />

                  <DashboardFieldCombobox
                    disabled={draft?.aggregation === "count"}
                    label={draft?.type === "donut_chart" ? "값" : "Y축"}
                    onValueChange={(valueKey) => setDraft((current) => current ? { ...current, valueKey } : current)}
                    options={numericColumnOptions}
                    placeholder={draft?.aggregation === "count" ? "행 개수" : "숫자 컬럼 선택"}
                    value={draft?.aggregation === "count" ? "" : draft?.valueKey ?? ""}
                  />

                  <Field>
                    <FieldLabel>집계 방식</FieldLabel>
                    <Select
                      value={draft?.aggregation ?? "sum"}
                      onValueChange={(value) => selectAggregation(value as SqlChartConfig["aggregation"])}
                    >
                      <SelectTrigger size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {sqlChartAggregations.map((aggregation) => (
                            <SelectItem key={aggregation} value={aggregation}>{aggregationLabels[aggregation]}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  {validationMessage ? <FieldError>{validationMessage}</FieldError> : null}
                </FieldGroup>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)] overflow-hidden" size="none">
            <CardHeader className="p-4">
              <CardTitle className="text-base">미리보기</CardTitle>
              <CardDescription>{selectedSource?.label ?? "데이터 소스를 선택해 주세요."}</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 p-0">
              <ScrollArea className="h-full" scrollbars="both" type="always">
                {selectedSource && draft ? <SqlResultChart chartConfig={draft} source={selectedSource} /> : null}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
          <Button
            disabled={!draft || Boolean(validationMessage)}
            type="button"
            onClick={() => {
              if (!draft || validationMessage) return;
              onApply(draft);
              onOpenChange(false);
            }}
          >
            차트 적용
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
