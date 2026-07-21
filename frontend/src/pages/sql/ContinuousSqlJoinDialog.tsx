import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CatalogDataset } from "../../types";
import type { ContinuousSqlJob } from "../../services/continuousSqlApi";

export function ContinuousSqlJoinDialog({
  catalogDataset,
  error,
  featureEnabled,
  onCreate,
  onOpenChange,
  onOutputNameChange,
  onTriggerIntervalChange,
  open,
  outputName,
  pending,
  progressMessage,
  result,
  servingMode,
  staticDatasets,
  streamingDataset,
  triggerIntervalSeconds,
}: {
  catalogDataset: CatalogDataset | null;
  error: string | null;
  featureEnabled: boolean;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
  onOutputNameChange: (value: string) => void;
  onTriggerIntervalChange: (value: number) => void;
  open: boolean;
  outputName: string;
  pending: boolean;
  progressMessage: string | null;
  result: ContinuousSqlJob | null;
  servingMode: "iceberg" | "clickhouse";
  staticDatasets: CatalogDataset[];
  streamingDataset: CatalogDataset;
  triggerIntervalSeconds: number;
}) {
  const failed = result?.observedState === "failed";
  const catalogReady = Boolean(catalogDataset);
  const title = catalogReady
    ? "실시간 JOIN 카탈로그가 준비됐습니다"
    : failed
      ? "실시간 JOIN 시작에 실패했습니다"
      : result
        ? "실시간 JOIN 실행 상태를 확인하고 있습니다"
        : "실시간 JOIN 만들기";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {catalogReady
              ? "실제 Kafka 이벤트가 JOIN되어 카탈로그와 대시보드 데이터 소스에 게시됐습니다."
              : result
                ? "Kafka 소비와 JOIN이 정상이어도 첫 실제 이벤트 전에는 카탈로그 게시 완료로 표시하지 않습니다."
                : servingMode === "iceberg"
                  ? "현재 SQL을 Trino 계약으로 검증한 뒤 Kafka 이벤트와 고정된 정적 스냅샷을 Spark에서 계속 JOIN하고 Iceberg에 게시합니다."
                  : "현재 SQL을 검증한 뒤 Kafka 이벤트와 고정된 정적 스냅샷을 ClickHouse에서 계속 JOIN합니다."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className={`grid gap-3 rounded-lg border p-4 text-sm ${catalogReady ? "border-emerald-200 bg-emerald-50 text-emerald-950" : failed ? "border-red-200 bg-red-50 text-red-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={catalogReady ? "success" : failed ? "destructive" : "default"}>
                {catalogReady ? "카탈로그 게시 완료" : failed ? "실행 실패" : result.observedState === "running" ? "Kafka JOIN 실행 중" : "준비 중"}
              </Badge>
              <strong>{result.outputDatasetName}</strong>
            </div>
            <span>Catalog Dataset ID: {result.outputDatasetId}</span>
            <span>Continuous Job ID: {result.id}</span>
            {progressMessage && <span>{progressMessage}</span>}
            {error && <FieldError>{error}</FieldError>}
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div><strong>실시간</strong> · {streamingDataset.name}</div>
              <div><strong>정적 JOIN</strong> · {staticDatasets.map((dataset) => dataset.name).join(", ")}</div>
              <div><strong>출력 엔진</strong> · {servingMode === "iceberg" ? "Spark / Iceberg" : "ClickHouse"} / GOLD</div>
            </div>
            <Field>
              <FieldLabel htmlFor="continuous-sql-output-name">출력 카탈로그 이름</FieldLabel>
              <Input
                id="continuous-sql-output-name"
                maxLength={255}
                onChange={(event) => onOutputNameChange(event.target.value)}
                value={outputName}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="continuous-sql-trigger">반영 시작 간격</FieldLabel>
              <Input
                id="continuous-sql-trigger"
                max={3600}
                min={1}
                onChange={(event) => onTriggerIntervalChange(Number(event.target.value))}
                type="number"
                value={triggerIntervalSeconds}
              />
              <FieldDescription>기본 5초입니다. 실제 대시보드 반영 시간에는 JOIN과 게시 처리 시간이 추가됩니다.</FieldDescription>
            </Field>
            {!featureEnabled && <FieldError>서버의 Continuous SQL 기능이 비활성화되어 있습니다.</FieldError>}
            {pending && progressMessage && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                {progressMessage}
              </div>
            )}
            {error && <FieldError>{error}</FieldError>}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">{result ? "닫기" : "취소"}</Button>
          {!result && (
            <Button
              disabled={!featureEnabled || !outputName.trim() || pending || triggerIntervalSeconds < 1 || triggerIntervalSeconds > 3600}
              onClick={onCreate}
              type="button"
              variant="primary"
            >
              {pending ? "자동 검증 및 시작 중…" : "카탈로그 만들고 시작"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
