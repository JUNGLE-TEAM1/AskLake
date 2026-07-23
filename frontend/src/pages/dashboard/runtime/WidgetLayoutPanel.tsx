import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsPanel } from "@/components/ui/settings-panel";
import type { DashboardRuntimeWidget, DashboardWidgetLayout } from "../../../types";
import { draftFromLayout, layoutFromDraft, type LayoutDraft } from "./widgetLayoutEditor";

export function WidgetLayoutPanel({
  widget,
  onApplyLayout,
}: {
  widget: DashboardRuntimeWidget;
  onApplyLayout: (widgetId: string, layout: DashboardWidgetLayout) => void;
}) {
  const [draft, setDraft] = useState<LayoutDraft>(() => draftFromLayout(widget.layout));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromLayout(widget.layout));
    setError(null);
  }, [widget.id, widget.layout.h, widget.layout.w, widget.layout.x, widget.layout.y]);

  const updateDraft = (key: keyof LayoutDraft) => (event: ChangeEvent<HTMLInputElement>) => {
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  };

  const applyLayout = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextLayout = layoutFromDraft(widget, draft);
    if (typeof nextLayout === "string") {
      setError(nextLayout);
      return;
    }

    setError(null);
    onApplyLayout(widget.id, nextLayout);
  };

  return (
    <SettingsPanel
      bodyClassName="contents"
      className="asklake-widget-layout-panel"
      header={(
        <div className="asklake-widget-config-heading">
          <div>
            <span>배치</span>
            <strong>좌표 및 크기</strong>
          </div>
        </div>
      )}
    >
      <form className="asklake-widget-config-form" onSubmit={applyLayout}>
        <FieldGroup className="contents">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={`${widget.id}-layout-x`}>X (열)</FieldLabel>
              <Input id={`${widget.id}-layout-x`} inputMode="numeric" min={0} size="sm" type="number" value={draft.x} onChange={updateDraft("x")} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${widget.id}-layout-y`}>Y (행)</FieldLabel>
              <Input id={`${widget.id}-layout-y`} inputMode="numeric" min={0} size="sm" type="number" value={draft.y} onChange={updateDraft("y")} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${widget.id}-layout-w`}>너비 (열)</FieldLabel>
              <Input id={`${widget.id}-layout-w`} inputMode="numeric" min={widget.layout.minW ?? 1} size="sm" type="number" value={draft.w} onChange={updateDraft("w")} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${widget.id}-layout-h`}>높이 (행)</FieldLabel>
              <Input id={`${widget.id}-layout-h`} inputMode="numeric" min={widget.layout.minH ?? 1} size="sm" type="number" value={draft.h} onChange={updateDraft("h")} />
            </Field>
          </div>
          <p className="text-xs leading-5 text-slate-500">데스크톱 기준 12열 그리드입니다. 다른 위젯과 겹치는 배치는 적용되지 않습니다.</p>
          {error ? <FieldError>{error}</FieldError> : null}
          <div className="asklake-widget-config-actions">
            <Button className="asklake-widget-create-button" type="submit">배치 적용</Button>
          </div>
        </FieldGroup>
      </form>
    </SettingsPanel>
  );
}
