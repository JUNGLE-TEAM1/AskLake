import { Trash2 } from "lucide-react";
import { formatDashboardDateLabel, splitDashboardTags } from "../dashboardListUtils";
import { dashboardStatusMeta } from "../../../utils/statusMeta";
import type { SavedDashboardCard } from "../../../types";

export function DashboardTable({
  deletingDashboardId,
  dashboards,
  onDeleteDashboard,
  onOpenDetail,
}: {
  deletingDashboardId?: string | null;
  dashboards: SavedDashboardCard[];
  onDeleteDashboard: (dashboard: SavedDashboardCard) => void;
  onOpenDetail: (name: string) => void;
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
            <th>작업</th>
          </tr>
        </thead>
        <tbody>
          {dashboards.map((dashboard) => (
            <tr key={dashboard.id}>
              <td>
                <button className="dashboard-row-link" type="button" onClick={() => onOpenDetail(dashboard.name)}>{dashboard.name}</button>
                <span className="dashboard-row-tags">
                  {[...splitDashboardTags(dashboard.tags), dashboardStatusMeta[dashboard.status].label].map((tag, tagIndex) => (
                    <span className="dashboard-row-tag" key={`${dashboard.id}-${tag}-${tagIndex}`}>{tag}</span>
                  ))}
                </span>
              </td>
              <td>{dashboard.owner}</td>
              <td>{dashboard.updated}</td>
              <td>{formatDashboardDateLabel(dashboard.createdAtValue ?? dashboard.createdAt)}</td>
              <td className="dashboard-row-actions">
                <button
                  aria-label={`${dashboard.name} 삭제`}
                  className="dashboard-row-delete"
                  disabled={deletingDashboardId === dashboard.id}
                  title={`${dashboard.name} 삭제`}
                  type="button"
                  onClick={() => onDeleteDashboard(dashboard)}
                >
                  <Trash2 size={16} />
                  <span>{deletingDashboardId === dashboard.id ? "삭제 중" : "삭제"}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
