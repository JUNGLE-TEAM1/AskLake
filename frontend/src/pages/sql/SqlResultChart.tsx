import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { SqlResultDraft } from "../../types";

const MAX_CHART_ROWS = 30;

function toNumber(value: string) {
  const normalized = value.replaceAll(",", "").trim();
  if (normalized.length === 0) return null;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getNumericColumnIndex(resultDraft: SqlResultDraft) {
  return resultDraft.columns.findIndex((_, columnIndex) => {
    const values = resultDraft.rows
      .map((row) => row[columnIndex] ?? "")
      .filter((value) => value.trim().length > 0);

    return values.length > 0 && values.every((value) => toNumber(value) !== null);
  });
}

export function SqlResultChart({ resultDraft }: { resultDraft: SqlResultDraft }) {
  const chartModel = useMemo(() => {
    const numericColumnIndex = getNumericColumnIndex(resultDraft);
    const valueColumnIndex = numericColumnIndex >= 0 ? numericColumnIndex : 0;
    const labelColumnIndex = resultDraft.columns.findIndex((_, index) => index !== valueColumnIndex);
    const resolvedLabelColumnIndex = labelColumnIndex >= 0 ? labelColumnIndex : valueColumnIndex;
    const valueLabel = numericColumnIndex >= 0 ? resultDraft.columns[valueColumnIndex] : "행 수";
    const labelLabel = resultDraft.columns[resolvedLabelColumnIndex] ?? "항목";
    const data = resultDraft.rows.slice(0, MAX_CHART_ROWS).map((row, index) => ({
      label: row[resolvedLabelColumnIndex]?.trim() || `${index + 1}행`,
      value: numericColumnIndex >= 0 ? toNumber(row[valueColumnIndex] ?? "") ?? 0 : 1,
    }));
    const config = {
      value: {
        color: "var(--color-blue-600)",
        label: valueLabel,
      },
    } satisfies ChartConfig;

    return { config, data, labelLabel, valueLabel };
  }, [resultDraft]);

  return (
    <section className="grid min-w-[720px] gap-3 p-4" aria-label="SQL 결과 차트">
      <div className="grid gap-1">
        <strong className="text-base">{chartModel.valueLabel} 분석</strong>
        <span className="text-sm text-muted-foreground">
          {chartModel.labelLabel} 기준 · 최대 {MAX_CHART_ROWS}개 행
        </span>
      </div>
      <ChartContainer
        className="h-[360px] w-full aspect-auto"
        config={chartModel.config}
        initialDimension={{ width: 960, height: 360 }}
      >
        <BarChart accessibilityLayer data={chartModel.data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="label"
            minTickGap={24}
            tickLine={false}
            tickMargin={10}
          />
          <YAxis axisLine={false} tickLine={false} width={64} />
          <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
          <Bar dataKey="value" fill="var(--color-value)" radius={6} />
        </BarChart>
      </ChartContainer>
    </section>
  );
}
