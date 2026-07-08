import { Button } from "@/components/ui/button";
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
    <div className="dashboard-delete-modal" role="dialog" aria-modal="true" aria-label="대시보드 삭제">
      <section>
        <h2>대시보드를 삭제할까요?</h2>
        <p>
          <strong>{dashboard.name}</strong> 대시보드를 삭제하면 목록과 데이터베이스에서 제거됩니다.
          삭제 후에는 되돌릴 수 없습니다.
        </p>
        {error && <p className="dashboard-delete-error">{error}</p>}
        <div className="form-actions inline">
          <Button className="secondary-button" type="button" disabled={isDeleting} onClick={onCancel} size="sm" variant="outline">취소</Button>
          <Button className="primary-button danger-button" type="button" disabled={isDeleting} onClick={onConfirm} size="sm" variant="destructive">
            {isDeleting ? "삭제 중" : "삭제"}
          </Button>
        </div>
      </section>
    </div>
  );
}
