import { Trash2 } from "lucide-react";
import { formatDashboardDateLabel, splitDashboardTags } from "../dashboardListUtils";
import { dashboardStatusMeta } from "../../../utils/statusMeta";
import type { SavedDashboardCard } from "../../../types";

export function DashboardTable({
  dashboards,
  deletingDashboardId,
  onOpenDetail,
  onRequestDelete,
}: {
  dashboards: SavedDashboardCard[];
  deletingDashboardId: string | null;
  onOpenDetail: (dashboard: SavedDashboardCard) => void;
  onRequestDelete: (dashboard: SavedDashboardCard) => void;
}) {
  return (
    <div className="dashboard-table-scroll">
      <table className="schema-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>소유자</th>
            <th>마지막 수정</th>
            <th>생성 일시</th>
            <th aria-label="삭제" />
          </tr>
        </thead>
        <tbody>
          {dashboards.map((dashboard) => (
            <tr className="dashboard-table-row" key={dashboard.id} onClick={() => onOpenDetail(dashboard)}>
              <td>
                <button
                  className="dashboard-row-link"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenDetail(dashboard);
                  }}
                >
                  {dashboard.name}
                </button>
                <span className="dashboard-row-tags">
                  {[...splitDashboardTags(dashboard.tags), dashboardStatusMeta[dashboard.status].label].map((tag, tagIndex) => (
                    <span className="dashboard-row-tag" key={`${dashboard.id}-${tag}-${tagIndex}`}>{tag}</span>
                  ))}
                </span>
              </td>
              <td>
                <div className="dashboard-owner-stack">
                  <span>{dashboard.owner}</span>
                  <small>Created: {dashboard.createdByProfile?.displayName || dashboard.createdBy || dashboard.owner}</small>
                </div>
              </td>
              <td>{dashboard.updated}</td>
              <td>{formatDashboardDateLabel(dashboard.createdAtValue ?? dashboard.createdAt)}</td>
              <td className="dashboard-table-action-cell">
                <button
                  className="dashboard-row-delete-button"
                  type="button"
                  disabled={deletingDashboardId === dashboard.id}
                  title="대시보드 삭제"
                  aria-label={`${dashboard.name} 삭제`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDelete(dashboard);
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
