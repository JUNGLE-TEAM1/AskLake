import { useEffect, useState, type RefObject } from "react";

type ObservedChartSize = {
  height: number;
  width: number;
};

export function useObservedChartSize(chartContainerRef: RefObject<HTMLDivElement | null>) {
  const [chartSize, setChartSize] = useState<ObservedChartSize | null>(null);

  useEffect(() => {
    const chartContainer = chartContainerRef.current;
    if (!chartContainer || typeof ResizeObserver === "undefined") return undefined;

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const height = Math.round(entry.contentRect.height);
      const width = Math.round(entry.contentRect.width);
      if (height <= 0 || width <= 0) return;

      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        setChartSize((current) => (
          current?.height === height && current.width === width ? current : { height, width }
        ));
      });
    });
    resizeObserver.observe(chartContainer);

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
    };
  }, [chartContainerRef]);

  return chartSize;
}
