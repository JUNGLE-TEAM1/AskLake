import type { CatalogDataset, SqlResultDraft } from "../../types";

export function SqlDashboardPreview({
  dataset,
  resultDraft,
}: {
  dataset: CatalogDataset;
  resultDraft: SqlResultDraft;
}) {
  const previewRows = resultDraft.rows.slice(0, 4);
  const previewColumns = resultDraft.columns.slice(0, 4);
  const numericColumnIndex = resultDraft.columns.findIndex((column) => {
    const lowerColumn = column.toLowerCase();
    return lowerColumn.includes("amount") || lowerColumn.includes("count") || lowerColumn.includes("score") || lowerColumn.includes("total");
  });
  const kpiValue = numericColumnIndex >= 0
    ? formatDashboardNumber(previewRows.reduce((sum, row) => sum + (Number(row[numericColumnIndex]) || 0), 0))
    : formatDashboardNumber(resultDraft.rowCount);
  const barValues = previewRows.length > 0
    ? previewRows.map((row, index) => {
        const value = numericColumnIndex >= 0 ? Number(row[numericColumnIndex]) || 0 : index + 1;
        return Math.max(12, Math.min(96, Math.round((value / Math.max(1, Math.max(...previewRows.map((item, itemIndex) => (
          numericColumnIndex >= 0 ? Number(item[numericColumnIndex]) || 0 : itemIndex + 1
        ))))) * 96)));
      })
    : [36, 58, 74, 52];

  return (
    <div className="sql-dashboard-preview">
      <div className="sql-dashboard-preview-hero">
        <div>
          <span>LIVE PREVIEW</span>
          <strong>{dataset.name}</strong>
          <p>{resultDraft.rowCount.toLocaleString()} rows · {resultDraft.columns.length} columns · {resultDraft.runId}</p>
        </div>
        <div className="sql-dashboard-kpi">
          <span>{numericColumnIndex >= 0 ? resultDraft.columns[numericColumnIndex] : "rows"}</span>
          <strong>{kpiValue}</strong>
          <em>Preview 기반</em>
        </div>
      </div>
      <div className="sql-dashboard-preview-grid">
        <section className="sql-dashboard-preview-panel">
          <div className="sql-dashboard-preview-title">
            <span>BAR</span>
            <strong>{numericColumnIndex >= 0 ? resultDraft.columns[numericColumnIndex] : "row distribution"}</strong>
          </div>
          <div className="sql-dashboard-bars">
            {barValues.map((value, index) => (
              <i key={`${resultDraft.runId}-bar-${index}`} style={{ height: `${value}%` }} />
            ))}
          </div>
        </section>
        <section className="sql-dashboard-preview-panel">
          <div className="sql-dashboard-preview-title">
            <span>TABLE</span>
            <strong>Preview sample</strong>
          </div>
          <table className="sql-dashboard-table-preview">
            <thead>
              <tr>{previewColumns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {previewRows.slice(0, 3).map((row, rowIndex) => (
                <tr key={`${resultDraft.runId}-dashboard-row-${rowIndex}`}>
                  {previewColumns.map((_, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{row[cellIndex] ?? "-"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function formatDashboardNumber(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
