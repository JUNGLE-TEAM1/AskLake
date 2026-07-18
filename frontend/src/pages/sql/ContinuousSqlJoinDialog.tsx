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
  error,
  featureEnabled,
  onCreate,
  onOpenChange,
  onOutputNameChange,
  onTriggerIntervalChange,
  open,
  outputName,
  pending,
  result,
  staticDatasets,
  streamingDataset,
  triggerIntervalSeconds,
}: {
  error: string | null;
  featureEnabled: boolean;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
  onOutputNameChange: (value: string) => void;
  onTriggerIntervalChange: (value: number) => void;
  open: boolean;
  outputName: string;
  pending: boolean;
  result: ContinuousSqlJob | null;
  staticDatasets: CatalogDataset[];
  streamingDataset: CatalogDataset;
  triggerIntervalSeconds: number;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{result ? "실시간 JOIN이 시작됐습니다" : "ClickHouse 실시간 JOIN 만들기"}</DialogTitle>
          <DialogDescription>
            {result
              ? "첫 micro-batch가 게시되면 GOLD 카탈로그가 나타나며 대시보드 데이터 소스로 바로 선택할 수 있습니다."
              : "현재 SQL을 검증한 뒤 Kafka 이벤트와 고정된 정적 스냅샷을 ClickHouse에서 계속 JOIN합니다."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="grid gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">시작 요청 완료</Badge>
              <strong>{result.outputDatasetName}</strong>
            </div>
            <span>Catalog Dataset ID: {result.outputDatasetId}</span>
            <span>Continuous Job ID: {result.id}</span>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div><strong>실시간</strong> · {streamingDataset.name}</div>
              <div><strong>정적 JOIN</strong> · {staticDatasets.map((dataset) => dataset.name).join(", ")}</div>
              <div><strong>출력 엔진</strong> · ClickHouse / GOLD</div>
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
              <FieldDescription>기본 1초입니다. 실제 대시보드 반영 시간에는 JOIN과 게시 처리 시간이 추가됩니다.</FieldDescription>
            </Field>
            {!featureEnabled && <FieldError>서버의 Continuous SQL 또는 ClickHouse 기능이 비활성화되어 있습니다.</FieldError>}
            {error && <FieldError>{error}</FieldError>}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">{result ? "확인" : "취소"}</Button>
          {!result && (
            <Button
              disabled={!featureEnabled || !outputName.trim() || pending || triggerIntervalSeconds < 1 || triggerIntervalSeconds > 3600}
              onClick={onCreate}
              type="button"
              variant="primary"
            >
              {pending ? "검증 및 시작 중…" : "카탈로그 만들고 시작"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
