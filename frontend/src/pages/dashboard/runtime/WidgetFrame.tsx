import { Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DashboardRuntimeWidget } from "../../../types";
import { dashboardWidgetDefinitions } from "./widgetDefinitions";
import { WidgetRenderer } from "./WidgetRenderer";
import type { DashboardAssistantRuntimeContext } from "./dashboardRuntimeTypes";
import type { DashboardAssistantWidgetPatch } from "../../../services/dashboardAssistantService";

function placeholderKind(widget: DashboardRuntimeWidget) {
  const kind = (widget.config as { placeholderKind?: unknown }).placeholderKind;
  if (kind === "visualization_request" || kind === "text") return kind;
  if (widget.title === "시각화 요청" && !widget.datasetId && widget.data.length === 0) {
    return "visualization_request";
  }
  return null;
}

function widgetTypeLabel(widget: DashboardRuntimeWidget) {
  const kind = placeholderKind(widget);
  if (kind === "visualization_request") return "시각화";
  if (kind === "text") return "텍스트";
  return dashboardWidgetDefinitions[widget.type]?.label ?? widget.type;
}

function clampSpan(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(12, Math.max(1, Math.round(value ?? fallback)));
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function WidgetFrame({
  assistantContext,
  deleteDisabled = false,
  editable = false,
  onDelete,
  onApplyWidgetPatch,
  onPatchConfig,
  onRetryData,
  onSelect,
  onSelectColorSlot,
  selected = false,
  widget,
}: {
  assistantContext?: DashboardAssistantRuntimeContext;
  deleteDisabled?: boolean;
  editable?: boolean;
  onDelete?: (widgetId: string) => void;
  onApplyWidgetPatch?: (widget: DashboardRuntimeWidget, patch: DashboardAssistantWidgetPatch) => Promise<boolean>;
  onPatchConfig?: (widget: DashboardRuntimeWidget, patch: Record<string, unknown>) => Promise<boolean>;
  onRetryData?: (widgetId: string) => void;
  onSelect?: (widgetId: string) => void;
  onSelectColorSlot?: (widgetId: string, slotIndex: number) => void;
  selected?: boolean;
  widget: DashboardRuntimeWidget;
}) {
  const columnSpan = clampSpan(widget.layout?.w, 4);
  const rowSpan = clampSpan(widget.layout?.h, 4);
  const isAiWorking = assistantContext?.workingWidgetId === widget.id;
  const isDataLoading = widget.dataStatus === "pending" || widget.dataStatus === "loading";
  const hasDataError = widget.dataStatus === "error";
  const liveRevision = widget.liveRefresh === true && typeof widget.appliedRevision === "number"
    ? widget.appliedRevision
    : null;

  return (
    <article
      aria-busy={isAiWorking || isDataLoading || undefined}
      className={cx(
        "asklake-widget-frame",
        editable && "editable",
        selected && "selected",
        isAiWorking && "ai-working",
        liveRevision !== null && "live",
      )}
      style={{
        gridColumn: editable ? undefined : `span ${columnSpan}`,
        minHeight: editable ? undefined : `${Math.max(160, rowSpan * 56)}px`,
      }}
      onClick={(event) => {
        if (!editable) return;
        event.stopPropagation();
        if (selected) return;
        onSelect?.(widget.id);
      }}
    >
      <header>
        <div className="asklake-widget-heading">
          <span>{widgetTypeLabel(widget)}</span>
          <h2>{widget.title || "제목 없는 위젯"}</h2>
        </div>
        <div className="asklake-widget-header-actions">
          {liveRevision !== null && (
            <span
              aria-live="polite"
              className="asklake-widget-live-status"
              title={`데이터셋 revision ${liveRevision.toLocaleString("ko-KR")}까지 반영됨`}
            >
              <span aria-hidden="true" className="asklake-widget-live-dot" />
              실시간
            </span>
          )}
          {editable && selected && (
            <Button
              aria-label={`${widget.title || "제목 없는 위젯"} 삭제`}
              className="asklake-widget-delete-button widget-control"
              disabled={deleteDisabled}
              title="위젯 삭제"
              type="button"
              size="icon"
              variant="destructive"
              onClick={(event) => {
                event.stopPropagation();
                onDelete?.(widget.id);
              }}
            >
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </header>
      <div className="asklake-widget-frame-body">
        {isDataLoading ? (
          <div className="asklake-widget-data-state" role="status" aria-live="polite">
            위젯 데이터를 불러오는 중입니다.
          </div>
        ) : hasDataError ? (
          <div className="asklake-widget-data-state error" role="alert">
            <span>{widget.dataError || "위젯 데이터를 불러오지 못했습니다."}</span>
            <Button type="button" size="sm" variant="outline" onClick={(event) => {
              event.stopPropagation();
              onRetryData?.(widget.id);
            }}>
              다시 시도
            </Button>
          </div>
        ) : (
          <WidgetRenderer
            assistantContext={assistantContext}
            widget={widget}
            onApplyWidgetPatch={onApplyWidgetPatch ? (patch) => onApplyWidgetPatch(widget, patch) : undefined}
            onPatchConfig={onPatchConfig ? (patch) => onPatchConfig(widget, patch) : undefined}
            onSelectColorSlot={onSelectColorSlot ? (slotIndex) => onSelectColorSlot(widget.id, slotIndex) : undefined}
          />
        )}
      </div>
      {isAiWorking && (
        <div className="asklake-ai-working-overlay" role="status" aria-live="polite">
          <span aria-hidden="true" className="asklake-ai-working-icon">
            <Sparkles size={16} />
          </span>
          <strong>AI 시각화 작업중</strong>
        </div>
      )}
      {liveRevision !== null && (
        <span
          aria-hidden="true"
          className="asklake-widget-live-pulse"
          key={`live-revision-${liveRevision}`}
        />
      )}
    </article>
  );
}
