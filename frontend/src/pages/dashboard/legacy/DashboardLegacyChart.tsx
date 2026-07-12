import type { ExpandedChart } from "../DashboardParts";
import type { DashboardLegacyModel } from "./dashboardLegacyModel";

export function DashboardLegacyChart({
  expanded = false,
  kind,
  model,
}: {
  expanded?: boolean;
  kind: ExpandedChart["kind"];
  model: DashboardLegacyModel;
}) {
  if (kind === "category") {
    return (
      <div className={expanded ? "dashboard-category-chart expanded" : "dashboard-category-chart"}>
        <div className="dashboard-axis-labels">
          {["124500", "93375", "62250", "31125", "0"].map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="dashboard-category-bars">
          {model.categorySales.map(([label, value]) => (
            <span key={label} style={{ height: `${Math.max(28, value / (expanded ? 720 : 1200))}px` }}>
              <i>{label}</i>
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (kind === "channels") {
    return (
      <div className={expanded ? "dashboard-donut-area expanded" : "dashboard-donut-area"}>
        <div className="dashboard-donut" />
        <div className="dashboard-channel-list">
          {model.channelRows.map(([name, orders, revenue, share]) => (
            <p key={name}><span>{name}</span><strong>{orders}</strong><em>{revenue}</em><small>{share}</small></p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={expanded ? "dashboard-bar-chart expanded" : "dashboard-bar-chart"} aria-label="일별 주문 막대 차트">
      {model.barSeries.map((value, index) => (
        <span key={value + index} style={{ height: `${Math.max(26, expanded ? value * 1.5 : value)}px` }}>
          <i>{["월", "화", "수", "목", "금", "토", "일"][index]}</i>
        </span>
      ))}
    </div>
  );
}
