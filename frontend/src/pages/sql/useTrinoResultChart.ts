import { useCallback, useEffect, useMemo, useState } from "react";

import { getTrinoQueryRunChart } from "../../services/sqlQueryApi";
import type { TrinoQueryRun, TrinoQueryRunChart } from "../../types";
import type { SqlChartConfig, SqlChartSource } from "./SqlResultChart";
import {
  createTrinoResultChartRequestKey,
  resolveTrinoResultChartSource,
} from "./trinoResultChartState";

type TrinoResultChartState = {
  error: string | null;
  key: string;
  pending: boolean;
  result: TrinoQueryRunChart | null;
};

const INITIAL_STATE: TrinoResultChartState = {
  error: null,
  key: "",
  pending: false,
  result: null,
};

export function useTrinoResultChart({
  chartConfig,
  fullResultRun,
  source,
}: {
  chartConfig: SqlChartConfig | null;
  fullResultRun: TrinoQueryRun | null;
  source?: SqlChartSource;
}) {
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<TrinoResultChartState>(INITIAL_STATE);
  const requestKey = useMemo(
    () => createTrinoResultChartRequestKey({ chartConfig, fullResultRun, retryToken, source }),
    [chartConfig, fullResultRun, retryToken, source],
  );

  useEffect(() => {
    if (!requestKey || !chartConfig || !fullResultRun) {
      setState(INITIAL_STATE);
      return;
    }
    const controller = new AbortController();
    setState({ error: null, key: requestKey, pending: true, result: null });
    void getTrinoQueryRunChart(
      fullResultRun.runId,
      chartConfig.type,
      chartConfig.config,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({ error: null, key: requestKey, pending: false, result });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          error: error instanceof Error ? error.message : "전체 SQL 결과 차트를 집계하지 못했습니다.",
          key: requestKey,
          pending: false,
          result: null,
        });
      });
    return () => controller.abort();
  }, [chartConfig, fullResultRun, requestKey]);

  const resolvedSource = useMemo<SqlChartSource | undefined>(() => {
    if (state.key !== requestKey) return undefined;
    return resolveTrinoResultChartSource(source, state.result);
  }, [requestKey, source, state.key, state.result]);
  const resolvedConfig = useMemo<SqlChartConfig | null>(() => {
    if (!chartConfig || state.key !== requestKey || !state.result) return null;
    return { ...chartConfig, config: state.result.config };
  }, [chartConfig, requestKey, state.key, state.result]);
  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  return {
    chartConfig: resolvedConfig,
    error: state.key === requestKey ? state.error : null,
    pending: Boolean(requestKey && (state.key !== requestKey || state.pending)),
    retry,
    source: resolvedSource,
  };
}
