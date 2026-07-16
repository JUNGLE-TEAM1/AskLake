import { Button } from "@/components/ui/button";
import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, ChevronDown, ChevronUp, Clock3, Repeat2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { InfoBox } from "../../components/common";
import type { DraftPipelinePatch, SourceDraft } from "../../types";
import type { SourceConnectionDefinition, SourceConnectorMeta } from "./sourceDefinitions";
import {
  isSecretSourceField,
  isVisibleSourceField,
  requiredSourceConnectionFields,
  sourceCheckIcon,
  sourceCheckState,
  sourceFieldLabel,
  sourceStatusIcon,
  sourceValueLabel,
} from "./sourceModel";

type ContinuousConfig = {
  initialOffsetPolicy: "earliest" | "latest";
  maxOffsetsPerTrigger: number;
  triggerIntervalSeconds: number;
};

export function SourceChoiceStage({
  connectorMeta,
  connectors,
  onSelect,
  sourceType,
}: {
  connectorMeta: Record<string, SourceConnectorMeta>;
  connectors: string[];
  onSelect: (connector: string) => void;
  sourceType: string;
}) {
  return (
    <div className="source-stage-screen source-choice-screen">
      <div className="source-select-heading">
        <h2>데이터 소스 선택</h2>
      </div>
      <div className="source-choice-grid">
        {connectors.map((connector) => {
          const meta = connectorMeta[connector];
          return (
            <Button
              aria-label={`${meta.label} 소스 선택`}
              aria-pressed={sourceType === connector}
              className="source-choice-button relative grid h-auto min-h-36 w-full grid-cols-[64px_minmax(0,1fr)] items-center justify-items-start gap-5 whitespace-normal px-10 py-8 text-left"
              key={connector}
              type="button"
              variant={sourceType === connector ? "subtle" : "outline"}
              onClick={() => onSelect(connector)}
            >
              {sourceType === connector && <span className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-full bg-blue-600 text-white"><Check /></span>}
              <span className="inline-flex size-16 items-center justify-center">{meta.icon}</span>
              <span className="grid min-w-0 gap-1.5">
                <span className="text-lg font-bold text-slate-950">{meta.label}</span>
                <span className="text-[13px] font-medium leading-5 text-slate-500">{meta.description}</span>
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function SourceConnectStage({
  activeSourceMeta,
  activeSourceType,
  connectionStatus,
  connectionStatusCopy,
  continuousAdvancedOpen,
  continuousConfig,
  current,
  displayTestItems,
  editableFields,
  isSqlResultSource,
  kafkaExecutionMode,
  onDraftChange,
  onFieldChange,
  onTestConnection,
  onUpdateContinuousConfig,
  setContinuousAdvancedOpen,
  sourceLocked,
}: {
  activeSourceMeta: SourceConnectorMeta;
  activeSourceType: string;
  connectionStatus: SourceDraft["connectionStatus"];
  connectionStatusCopy: Record<SourceDraft["connectionStatus"], { badge: string; title: string }>;
  continuousAdvancedOpen: boolean;
  continuousConfig: ContinuousConfig;
  current: SourceConnectionDefinition;
  displayTestItems: Array<[string, string]>;
  editableFields: Array<[string, string]>;
  isSqlResultSource: boolean;
  kafkaExecutionMode: "continuous" | "snapshot";
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onFieldChange: (label: string, value: string) => void;
  onTestConnection: () => Promise<void>;
  onUpdateContinuousConfig: (patch: Partial<ContinuousConfig>) => void;
  setContinuousAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  sourceLocked: boolean;
}) {
  const visibleEditableFields = editableFields.filter(([label]) => isVisibleSourceField(activeSourceType, label));

  return (
    <ScrollArea className="h-[calc(100vh-270px)] min-h-0">
      <div className="source-stage-screen">
        <section className="source-step-section active">
          <div className="source-step-header">
            <div className="source-step-brand" aria-hidden="true">{activeSourceMeta.icon}</div>
            <div><strong>{current.title}</strong></div>
            <div className="hegun-status-actions">
              {isSqlResultSource ? <span className="panel-note">연결 테스트 생략</span> : <Button type="button" disabled={connectionStatus === "testing"} onClick={onTestConnection}>연결 테스트</Button>}
            </div>
          </div>
          <div className="hegun-field-grid source-flow-fields">
            {visibleEditableFields.map(([label, value]) => (
              <FormFieldGroup
                className={value.length > 38 ? "field wide" : "field"}
                key={`${activeSourceType}-${label}`}
                label={requiredSourceConnectionFields(activeSourceType).includes(label) ? `${sourceFieldLabel(label)} *` : sourceFieldLabel(label)}
              >
                <Input
                  autoComplete={isSecretSourceField(label) ? "new-password" : undefined}
                  readOnly={isSqlResultSource}
                  type={isSecretSourceField(label) ? "password" : "text"}
                  value={value}
                  onChange={(event) => onFieldChange(label, event.target.value)}
                />
              </FormFieldGroup>
            ))}
          </div>
          {activeSourceType === "Stream / Kafka" && (
            <section className="source-step-section" aria-label="Kafka 실행 방식">
              <div className="source-step-header">
                <em>2</em>
                <div><strong>Kafka 실행 방식</strong></div>
              </div>
              <div className="kafka-execution-mode-grid" role="group" aria-label="Kafka 실행 방식 선택">
                <button aria-pressed={kafkaExecutionMode === "snapshot"} className={`kafka-execution-mode-card ${kafkaExecutionMode === "snapshot" ? "selected" : ""}`} disabled={sourceLocked} type="button" onClick={() => onDraftChange({ source: { executionMode: "snapshot" } })}>
                  <span className="kafka-execution-mode-icon"><Clock3 size={19} /></span>
                  <span className="kafka-execution-mode-copy"><strong>일괄 수집</strong><span>필요할 때 직접 실행하거나 일정에 맞춰 수집</span></span>
                  <span className="kafka-execution-mode-tag">배치</span>
                  {kafkaExecutionMode === "snapshot" && <span className="kafka-execution-mode-check"><Check size={14} /></span>}
                </button>
                <button aria-pressed={kafkaExecutionMode === "continuous"} className={`kafka-execution-mode-card ${kafkaExecutionMode === "continuous" ? "selected" : ""}`} disabled={sourceLocked} type="button" onClick={() => onUpdateContinuousConfig({})}>
                  <span className="kafka-execution-mode-icon"><Repeat2 size={19} /></span>
                  <span className="kafka-execution-mode-copy"><strong>실시간 수집</strong><span>새 메시지를 지속적으로 수집</span></span>
                  <span className="kafka-execution-mode-tag">스트리밍</span>
                  {kafkaExecutionMode === "continuous" && <span className="kafka-execution-mode-check"><Check size={14} /></span>}
                </button>
              </div>
              {kafkaExecutionMode === "continuous" && (
                <div className="kafka-continuous-settings">
                  <button aria-expanded={continuousAdvancedOpen} className="kafka-continuous-settings-toggle" type="button" onClick={() => setContinuousAdvancedOpen((open) => !open)}>
                    <span>고급 설정</span>
                    {continuousAdvancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                  {continuousAdvancedOpen && (
                    <div className="kafka-continuous-settings-grid">
                      <FormFieldGroup className="field" hint="새 체크포인트를 만들 때만 적용" label="시작 위치">
                        <NativeSelect disabled={sourceLocked} value={continuousConfig.initialOffsetPolicy} onChange={(event) => onUpdateContinuousConfig({ initialOffsetPolicy: event.target.value as "earliest" | "latest" })}>
                          <option value="earliest">처음부터 읽기</option>
                          <option value="latest">새 이벤트부터 읽기</option>
                        </NativeSelect>
                      </FormFieldGroup>
                      <FormFieldGroup className="field" hint="1~3600초" label="수집 실행 간격">
                        <Input disabled={sourceLocked} max={3600} min={1} type="number" value={continuousConfig.triggerIntervalSeconds} onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isInteger(value) && value >= 1 && value <= 3600) onUpdateContinuousConfig({ triggerIntervalSeconds: value });
                        }} />
                      </FormFieldGroup>
                      <FormFieldGroup className="field" hint="1~1,000,000건" label="한 번에 처리할 최대 메시지">
                        <Input disabled={sourceLocked} max={1_000_000} min={1} type="number" value={continuousConfig.maxOffsetsPerTrigger} onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isInteger(value) && value >= 1 && value <= 1_000_000) onUpdateContinuousConfig({ maxOffsetsPerTrigger: value });
                        }} />
                      </FormFieldGroup>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          {current.info && <InfoBox title={isSqlResultSource ? "SQL Preview 입력" : "보안 연결"} body={current.info} />}
        </section>

        <section className={`hegun-source-status-bar ${connectionStatus}`} aria-label="연결 테스트 상태">
          <div className="hegun-status-head">
            <div className="hegun-status-copy single-line">
              {sourceStatusIcon(connectionStatus)}
              <h2>{connectionStatusCopy[connectionStatus].title}</h2>
            </div>
            <div className="hegun-status-actions">
              {isSqlResultSource && <span className="panel-note">연결 테스트 생략</span>}
            </div>
          </div>
          <div className="hegun-test-strip">
            {displayTestItems.map(([label, value], index) => (
              <span className={sourceCheckState(value)} key={`${activeSourceType}-${label}-${index}`}>
                <i>{sourceCheckIcon(label)}</i>
                <strong>{sourceFieldLabel(label)}</strong>
                <em>{sourceValueLabel(value)}</em>
              </span>
            ))}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
