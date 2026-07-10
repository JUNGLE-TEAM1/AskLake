import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import type { SavedDashboardCard } from "../../../types";

export function DashboardDeleteConfirmDialog({
  dashboard,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  dashboard: SavedDashboardCard;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      bodyClassName="grid gap-3"
      contentClassName="dashboard-delete-dialog"
      footer={(
        <>
          <Button className="secondary-button" type="button" disabled={isDeleting} onClick={onCancel} size="sm" variant="outline">취소</Button>
          <Button className="primary-button danger-button" type="button" disabled={isDeleting} onClick={onConfirm} size="sm" variant="destructive">
            {isDeleting ? "삭제 중" : "삭제"}
          </Button>
        </>
      )}
      onClose={onCancel}
      size="sm"
      title="대시보드를 삭제할까요?"
    >
      <p className="m-0 text-sm font-semibold leading-6 text-slate-600">
        <strong>{dashboard.name}</strong> 대시보드를 삭제하면 목록과 데이터베이스에서 제거됩니다.
        삭제 후에는 되돌릴 수 없습니다.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>대시보드를 삭제하지 못했습니다.</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </DialogShell>
  );
}
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
