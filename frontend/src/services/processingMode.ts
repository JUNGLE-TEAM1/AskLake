type ProcessingModeRequest = {
  continuousConfig?: unknown;
  executionMode?: string;
};

export function describeProcessingMode(request: ProcessingModeRequest): string {
  if (request.executionMode !== "continuous") return "배치 · Spark";
  return "실시간 · Spark";
}
