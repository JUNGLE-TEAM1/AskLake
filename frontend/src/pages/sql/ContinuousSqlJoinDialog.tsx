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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
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
  open,
  outputName,
  pending,
  progressMessage,
  result,
  staticDatasets,
  streamingDataset,
}: {
  catalogDataset: CatalogDataset | null;
  error: string | null;
  featureEnabled: boolean;
  onCreate: () => void;
  onOpenChange: (open: boolean) => void;
  onOutputNameChange: (value: string) => void;
  open: boolean;
  outputName: string;
  pending: boolean;
  progressMessage: string | null;
  result: ContinuousSqlJob | null;
  staticDatasets: CatalogDataset[];
  streamingDataset: CatalogDataset;
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
              ? "producer Dataset revision이 JOIN되어 카탈로그 데이터 소스로 게시됐습니다."
              : result
                ? "producer Job이 게시한 첫 query 가능한 Dataset revision 전에는 카탈로그 게시 완료로 표시하지 않습니다."
                : "현재 SQL을 검증한 뒤 연결된 producer Dataset revision과 고정된 정적 스냅샷을 JOIN해 Iceberg에 게시합니다."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className={`grid gap-3 rounded-lg border p-4 text-sm ${catalogReady ? "border-emerald-200 bg-emerald-50 text-emerald-950" : failed ? "border-red-200 bg-red-50 text-red-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={catalogReady ? "success" : failed ? "destructive" : "default"}>
                {catalogReady ? "카탈로그 게시 완료" : failed ? "실행 실패" : result.observedState === "running" ? "JOIN 실행 중" : "준비 중"}
              </Badge>
              <strong>{result.outputDatasetName}</strong>
            </div>
            <span>Catalog Dataset ID: {result.outputDatasetId}</span>
            <span>Continuous Job ID: {result.id}</span>
            {result.refreshState && (
              <div className="grid gap-1 rounded-md border border-current/15 bg-white/40 p-3 text-xs">
                <strong>백엔드 Gold 갱신 상태 · {refreshStatusLabel(result.refreshState.status)}</strong>
                <span>Kafka 최신 revision · {result.refreshState.latestSourceRevision}</span>
                <span>현재 공개 Gold revision · {result.refreshState.publishedSourceRevision}</span>
                {result.refreshState.processingSourceRevision !== null
                  && result.refreshState.processingSourceRevision !== undefined
                  && <span>처리 중 revision · {result.refreshState.processingSourceRevision}</span>}
                {result.refreshState.lastError && <span>마지막 오류 · {result.refreshState.lastError}</span>}
              </div>
            )}
            {result.activeTreeRun && (
              <div className="grid gap-1 rounded-md border border-current/15 bg-white/40 p-3 text-xs">
                <strong>실행 트리 · {result.activeTreeRun.treeRunId}</strong>
                {result.activeTreeRun.nodes.map((node) => (
                  <span key={node.nodeRunId}>
                    {node.nodeType === "parent" ? "SQL parent" : node.nodeType === "realtime" ? "실시간 producer" : "배치 producer"}
                    {" · "}{node.jobId}{" · "}{node.status}
                  </span>
                ))}
              </div>
            )}
            {progressMessage && <span>{progressMessage}</span>}
            {error && <FieldError>{error}</FieldError>}
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div><strong>실시간 producer Dataset</strong> · {streamingDataset.name}</div>
              <div><strong>정적 JOIN</strong> · {staticDatasets.map((dataset) => dataset.name).join(", ")}</div>
              <div><strong>출력 엔진</strong> · Spark / Iceberg / GOLD</div>
              <div className="text-muted-foreground">Kafka 수집 크기와 주기는 producer Job 설정을 따릅니다.</div>
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
              disabled={!featureEnabled || !outputName.trim() || pending}
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

function refreshStatusLabel(status: NonNullable<ContinuousSqlJob["refreshState"]>["status"]) {
  switch (status) {
    case "running": return "새 데이터 JOIN 중";
    case "failed": return "마지막 JOIN 실패 · 이전 Gold 유지";
    case "catalog_ready": return "Catalog 검증 완료";
    case "dashboard_ready": return "새로고침 조회 가능";
    default: return "새 revision 대기";
  }
}
