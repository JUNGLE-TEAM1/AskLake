import { useState } from "react";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AuditResult, CatalogDataset, CatalogDatasetDeletionImpact } from "../../types";
import { canDeleteDataset, permissionDeniedMessage } from "../../utils/permissions";

export function CatalogDatasetDeleteAction({
  dataset,
  onAction,
  onDeleteDataset,
  onLoadDeletionImpact,
  pending,
}: {
  dataset: CatalogDataset;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDeleteDataset: (datasetId: string) => Promise<boolean>;
  onLoadDeletionImpact: (datasetId: string) => Promise<CatalogDatasetDeletionImpact>;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [impact, setImpact] = useState<CatalogDatasetDeletionImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const allowed = canDeleteDataset(dataset);

  const openDialog = async () => {
    setOpen(true);
    setConfirmation("");
    setImpact(null);
    setImpactError(null);
    setImpactLoading(true);
    onAction("catalog.dataset.delete_opened", `/api/catalog/datasets/${dataset.id}/deletion-impact`, dataset.id);
    try {
      setImpact(await onLoadDeletionImpact(dataset.id));
    } catch (error) {
      setImpactError(error instanceof Error ? error.message : "삭제 영향도를 불러오지 못했습니다.");
    } finally {
      setImpactLoading(false);
    }
  };

  const closeDialog = () => {
    if (pending) return;
    setOpen(false);
    setConfirmation("");
    setImpact(null);
    setImpactError(null);
  };

  const confirmDeletion = async () => {
    if (!impact?.canDelete || confirmation !== dataset.name) return;
    if (await onDeleteDataset(dataset.id)) closeDialog();
  };

  return (
    <div className="flex items-center pr-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`${dataset.name} 데이터셋 삭제`}
            className="text-slate-500 hover:bg-red-50 hover:text-red-700"
            disabled={pending || !allowed}
            onClick={(event) => {
              event.stopPropagation();
              void openDialog();
            }}
            size="iconSm"
            title={!allowed ? permissionDeniedMessage("데이터셋", "삭제") : "목록에서 데이터셋 삭제"}
            type="button"
            variant="ghost"
          >
            {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{allowed ? "데이터셋 삭제" : permissionDeniedMessage("데이터셋", "삭제")}</TooltipContent>
      </Tooltip>
      <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>데이터셋을 완전히 삭제하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              상세 화면으로 이동하지 않고 목록에서 바로 삭제합니다. AskLake가 관리하는 물리 데이터와 내부 메타데이터는 복구할 수 없습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <strong className="block text-slate-950">{dataset.name}</strong>
              {impactLoading ? <span className="mt-1 flex items-center gap-2 text-slate-500"><Loader2 className="size-4 animate-spin" /> 삭제 영향도를 확인하는 중...</span> : null}
              {impact ? <span className="mt-1 block text-slate-500">관리 artifact {impact.artifacts.length}개 · 약 {formatDeletionBytes(impact.estimatedSizeBytes)}</span> : null}
            </div>
            {impactError ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>삭제 영향도를 확인하지 못했습니다.</AlertTitle>
                <AlertDescription>{impactError}</AlertDescription>
              </Alert>
            ) : null}
            {impact?.blockers.length ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>먼저 연결된 리소스를 정리해 주세요.</AlertTitle>
                <AlertDescription>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {impact.blockers.map((item) => <li key={`${item.resourceType}:${item.resourceId}:${item.reason}`}>{item.resourceName}: {item.reason}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              확인을 위해 데이터셋 이름을 입력하세요.
              <Input
                aria-label="삭제할 데이터셋 이름 확인"
                autoComplete="off"
                disabled={pending}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={dataset.name}
                value={confirmation}
              />
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>취소</AlertDialogCancel>
            <Button
              disabled={impactLoading || !impact?.canDelete || confirmation !== dataset.name || pending}
              onClick={() => void confirmDeletion()}
              type="button"
              variant="destructive"
            >
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
              {pending ? "삭제하는 중..." : "완전히 삭제"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDeletionBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
