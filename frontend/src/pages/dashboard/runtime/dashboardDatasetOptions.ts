import type { DashboardDatasetOption } from "./dashboardRuntimeTypes";

export const mockDashboardDatasets: DashboardDatasetOption[] = [
  {
    id: "gold_logistics_cost_overview",
    name: "Logistics Cost Overview",
    layer: "gold",
    description: "운송비, 창고비, 총 물류비를 월/지역/운송사 기준으로 집계한 골드 데이터셋",
    columns: [
      { name: "month", type: "date" },
      { name: "region", type: "string" },
      { name: "carrier", type: "string" },
      { name: "transport_cost", type: "number" },
      { name: "warehouse_cost", type: "number" },
      { name: "total_cost", type: "number" },
    ],
  },
  {
    id: "gold_shipment_performance",
    name: "Shipment Performance",
    layer: "gold",
    description: "배송 리드타임, 정시 배송률, 배송 건수를 집계한 골드 데이터셋",
    columns: [
      { name: "ship_date", type: "date" },
      { name: "destination_region", type: "string" },
      { name: "service_level", type: "string" },
      { name: "shipment_count", type: "number" },
      { name: "on_time_rate", type: "number" },
      { name: "avg_lead_time_days", type: "number" },
    ],
  },
  {
    id: "gold_inventory_status",
    name: "Inventory Status",
    layer: "gold",
    description: "창고별 재고 수량, 재고 금액, 품절 위험 수량을 집계한 골드 데이터셋",
    columns: [
      { name: "snapshot_date", type: "date" },
      { name: "warehouse", type: "string" },
      { name: "sku_category", type: "string" },
      { name: "stock_quantity", type: "number" },
      { name: "inventory_value", type: "number" },
      { name: "stockout_risk_count", type: "number" },
    ],
  },
];
